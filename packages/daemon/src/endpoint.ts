import { lstatSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { UserFacingError, type LogRecord, type Logger } from "@janela/support";
import { Data, Match, Option, Result, Schema } from "effect";

export type SocketDirectoryProblem =
  | SocketDirectoryMissing
  | SocketDirectoryNotADirectory
  | SocketDirectoryWrongMode
  | SocketDirectoryWrongOwner;

export type PeerRefusal =
  | CredentialTruncated
  | CredentialUnavailable
  | CredentialVersion
  | UidMismatch;

export interface PeerCredential {
  readonly uid: number;
  readonly pid: number | undefined;
}

export interface RawPeerCredential {
  readonly xucred: Uint8Array | undefined;
  readonly pid: number | undefined;
}

export type PeerVerdict =
  | { readonly authorized: true; readonly credential: PeerCredential }
  | {
      readonly authorized: false;
      readonly refusal: PeerRefusal;
      readonly pid: number | undefined;
    };

export const MAXIMUM_SOCKET_PATH_LENGTH = 104;

export const SOCKET_DIRECTORY_MODE = 0o700;

export const XUCRED_BYTE_LENGTH = 76;

export const XUCRED_VERSION = 0;

const ALL_PERMISSION_BITS = 0o7777;

const MISSING_DIRECTORY_CODE = "ENOENT";

const decodeSystemErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

export class SocketDirectoryMissing extends Data.TaggedClass("missing")<Record<never, never>> {}

export class SocketDirectoryNotADirectory extends Data.TaggedClass("not-a-directory")<
  Record<never, never>
> {}

export class SocketDirectoryWrongOwner extends Data.TaggedClass("wrong-owner")<{
  readonly uid: number;
}> {}

export class SocketDirectoryWrongMode extends Data.TaggedClass("wrong-mode")<{
  readonly mode: number;
}> {}

export class CredentialUnavailable extends Data.TaggedClass("credential-unavailable")<
  Record<never, never>
> {}

export class CredentialTruncated extends Data.TaggedClass("credential-truncated")<{
  readonly received: number;
}> {}

export class CredentialVersion extends Data.TaggedClass("credential-version")<{
  readonly version: number;
}> {}

export class UidMismatch extends Data.TaggedClass("uid-mismatch")<{
  readonly peerUid: number;
}> {}

export function socketDirectoryProblemLabel(problem: SocketDirectoryProblem): string {
  return Match.value(problem).pipe(
    Match.tag("missing", () => "missing"),
    Match.tag("not-a-directory", () => "not-a-directory"),
    Match.tag("wrong-owner", () => "wrong-owner"),
    Match.tag("wrong-mode", () => "wrong-mode"),
    Match.exhaustive,
  );
}

export function peerRefusalLabel(refusal: PeerRefusal): string {
  return Match.value(refusal).pipe(
    Match.tag("credential-unavailable", () => "credential-unavailable"),
    Match.tag("credential-truncated", () => "credential-truncated"),
    Match.tag("credential-version", () => "credential-version"),
    Match.tag("uid-mismatch", () => "uid-mismatch"),
    Match.exhaustive,
  );
}

export class SocketPathTooLong extends UserFacingError {
  readonly byteCount: number;

  override readonly summary = "Janela can't create its background service socket.";

  constructor(byteCount: number) {
    super("socket path too long", {
      reason:
        `The socket path is ${byteCount} bytes and the system limit is ` +
        `${MAXIMUM_SOCKET_PATH_LENGTH}.`,
      recoverySuggestion: "This can happen when your home directory path is unusually long.",
    });

    this.byteCount = byteCount;
  }
}

export class SocketDirectoryUnsafe extends UserFacingError {
  readonly directory: string;

  readonly problem: SocketDirectoryProblem;

  override readonly summary = "Janela can't start its background service safely.";

  constructor(directory: string, problem: SocketDirectoryProblem) {
    super(`socket directory ${socketDirectoryProblemLabel(problem)}`, {
      reason: reasonForProblem(problem),
      recoverySuggestion:
        `Remove ${directory} and restart Janela; it will be recreated with the ` +
        `right permissions.`,
    });

    this.directory = directory;
    this.problem = problem;
  }
}

export function defaultSocketPath(): string {
  const path = join(homedir(), ".janela", "run", "janelad.sock");
  const byteCount = Buffer.byteLength(path, "utf8");

  if (byteCount > MAXIMUM_SOCKET_PATH_LENGTH) throw new SocketPathTooLong(byteCount);

  return path;
}

export function verifySocketDirectory(directory: string, ownUid: number): void {
  const attempted = Result.try(() => lstatSync(directory, { bigint: false }));
  const problem = Result.match(attempted, {
    onSuccess: (status) => problemWithStatus(status, ownUid),
    onFailure: (cause) => missingDirectoryOrRethrow(cause),
  });

  if (problem !== undefined) throw new SocketDirectoryUnsafe(directory, problem);
}

export function isAuthorized(credential: PeerCredential, ownUid: number): boolean {
  return credential.uid === ownUid;
}

export function verifyPeer(
  raw: RawPeerCredential,
  context: { readonly ownUid: number; readonly log: Logger },
): PeerVerdict {
  const { xucred, pid } = raw;

  if (xucred === undefined) {
    return refuse(new CredentialUnavailable(), pid, context.log);
  }

  if (xucred.byteLength < XUCRED_BYTE_LENGTH) {
    return refuse(new CredentialTruncated({ received: xucred.byteLength }), pid, context.log);
  }

  const view = new DataView(xucred.buffer, xucred.byteOffset, xucred.byteLength);
  const version = view.getUint32(0, true);

  if (version !== XUCRED_VERSION) {
    return refuse(new CredentialVersion({ version }), pid, context.log);
  }

  const credential: PeerCredential = { uid: view.getUint32(4, true), pid };

  if (!isAuthorized(credential, context.ownUid)) {
    return refuse(new UidMismatch({ peerUid: credential.uid }), pid, context.log);
  }

  context.log.debug(
    "peer verified",
    pid === undefined ? { uid: credential.uid } : { uid: credential.uid, pid },
  );

  return { authorized: true, credential };
}

function reasonForProblem(problem: SocketDirectoryProblem): string {
  return Match.value(problem).pipe(
    Match.tag("missing", () => "The socket directory doesn't exist yet."),
    Match.tag("not-a-directory", () => "The socket directory's path is not a directory."),
    Match.tag("wrong-owner", () => "The socket directory belongs to another user."),
    Match.tag(
      "wrong-mode",
      ({ mode }) =>
        `The socket directory's permissions are ${mode.toString(8)} ` +
        `and must be ${SOCKET_DIRECTORY_MODE.toString(8)}.`,
    ),
    Match.exhaustive,
  );
}

function missingDirectoryOrRethrow(cause: unknown): SocketDirectoryProblem {
  if (Option.getOrUndefined(decodeSystemErrorCode(cause))?.code === MISSING_DIRECTORY_CODE) {
    return new SocketDirectoryMissing();
  }

  throw cause;
}

function problemWithStatus(status: Stats, ownUid: number): SocketDirectoryProblem | undefined {
  if (!status.isDirectory()) return new SocketDirectoryNotADirectory();

  if (status.uid !== ownUid) return new SocketDirectoryWrongOwner({ uid: status.uid });

  const mode = status.mode & ALL_PERMISSION_BITS;

  if (mode !== SOCKET_DIRECTORY_MODE) return new SocketDirectoryWrongMode({ mode });

  return undefined;
}

function refusalFields(refusal: PeerRefusal, pid: number | undefined): LogRecord["fields"] {
  const label = peerRefusalLabel(refusal);
  const peerUid = Match.value(refusal).pipe(
    Match.tag("uid-mismatch", (mismatch) => mismatch.peerUid),
    Match.orElse(() => undefined),
  );

  if (peerUid === undefined) {
    return pid === undefined ? { refusal: label } : { refusal: label, pid };
  }

  return pid === undefined ? { refusal: label, peerUid } : { refusal: label, pid, peerUid };
}

function refuse(refusal: PeerRefusal, pid: number | undefined, log: Logger): PeerVerdict {
  log.notice("peer refused", refusalFields(refusal, pid));

  return { authorized: false, refusal, pid };
}
