import { lstatSync, type Stats } from "node:fs";

import { UserFacingError, type Logger } from "@janela/support";

/**
 * Where the daemon listens, and who is allowed to talk to it.
 *
 * Two unglamorous constraints shape everything here, and both are easy to get wrong
 * in a way that only fails on someone else's machine.
 */

/**
 * Maximum bytes in `sockaddr_un.sun_path`, measured on macOS 26.
 *
 * This is why the socket does not live beside the database in Application Support:
 * that path is already 73 bytes for a 15-character home directory and grows with
 * the username, which leaves too little headroom. See
 * docs/decisions/0016-daemon-protocol.md.
 */
export const MAXIMUM_SOCKET_PATH_LENGTH = 104;

/**
 * `~/.janela/run/janelad.sock` — 40 bytes for a typical home directory.
 *
 * @throws {SocketPathTooLong} when the home directory is long enough that even this
 *   path does not fit. Rare, and worth failing loudly for: a truncated `sun_path`
 *   does not error, it silently addresses a *different* socket, which is a far worse
 *   outcome than not starting.
 */
export function defaultSocketPath(): string {
  throw new Error(`not implemented: defaultSocketPath`);
}

/**
 * Mode for the directory containing the socket.
 *
 * The socket is a capability: anything that can connect can start processes as this
 * user. `0700` on the directory is the primary defence, and the peer-uid check is
 * the second.
 */
export const SOCKET_DIRECTORY_MODE = 0o700;

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

export type SocketDirectoryProblem = "missing" | "not-a-directory" | "wrong-owner" | "wrong-mode";

function reasonForProblem(problem: SocketDirectoryProblem, mode: number | undefined): string {
  switch (problem) {
    case "missing":
      return "The socket directory doesn't exist yet.";
    case "not-a-directory":
      return "The socket directory's path is not a directory.";
    case "wrong-owner":
      return "The socket directory belongs to another user.";
    case "wrong-mode":
      return (
        `The socket directory's permissions are ${mode === undefined ? "unknown" : mode.toString(8)} ` +
        `and must be ${SOCKET_DIRECTORY_MODE.toString(8)}.`
      );
  }
}

export class SocketDirectoryUnsafe extends UserFacingError {
  readonly directory: string;
  readonly problem: SocketDirectoryProblem;

  /** Permission bits actually found, for `"wrong-mode"` only. */
  readonly mode: number | undefined;

  override readonly summary = "Janela can't start its background service safely.";

  constructor(directory: string, problem: SocketDirectoryProblem, mode?: number) {
    super(`socket directory ${problem}`, {
      reason: reasonForProblem(problem, mode),
      recoverySuggestion:
        `Remove ${directory} and restart Janela; it will be recreated with the ` +
        `right permissions.`,
    });
    this.directory = directory;
    this.problem = problem;
    this.mode = mode;
  }
}

/**
 * Refuses to serve unless `directory` exists, is a real directory rather than a
 * symlink, belongs to `ownUid`, and has permission bits exactly
 * `SOCKET_DIRECTORY_MODE`.
 *
 * The directory mode is the primary defence — the peer-uid check is the second —
 * so it is verified before every listen rather than only where the directory is
 * created. `ownUid` is a parameter because `process.getuid` does not exist in a
 * WebView; the composition root reads it once.
 *
 * @throws {SocketDirectoryUnsafe}
 */
export function verifySocketDirectory(directory: string, ownUid: number): void {
  let status: Stats;
  try {
    // `lstat`, not `stat`: a symlink pointing at a world-writable directory must
    // fail here rather than be followed into.
    status = lstatSync(directory, { bigint: false });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new SocketDirectoryUnsafe(directory, "missing");
    }
    // Not user-facing: the caller logs it. Rule 10 — shown or logged, never both.
    throw error;
  }

  if (!status.isDirectory()) {
    throw new SocketDirectoryUnsafe(directory, "not-a-directory");
  }
  if (status.uid !== ownUid) {
    throw new SocketDirectoryUnsafe(directory, "wrong-owner");
  }

  // All twelve bits: setuid, setgid and sticky are refused along with group and
  // other access.
  const mode = status.mode & 0o7777;
  if (mode !== SOCKET_DIRECTORY_MODE) {
    throw new SocketDirectoryUnsafe(directory, "wrong-mode", mode);
  }
}

/**
 * `sizeof(struct xucred)` on macOS, measured at 76 bytes on macOS 26 (arm64 and
 * x86_64 share the layout). A `getsockopt` that reports fewer bytes did not fill
 * the struct, and is refused before any field is read.
 */
export const XUCRED_BYTE_LENGTH = 76;

/** `XUCRED_VERSION` from `<sys/ucred.h>`. Checked before any other field is trusted. */
export const XUCRED_VERSION = 0;

/**
 * What the operating system says about the process on the other end, once verified.
 *
 * Only `verifyPeer` produces one. `pid` is `LOCAL_PEERPID` and is for logs only —
 * a pid is reusable and must never be an authorisation input. It is `undefined`
 * when that one call failed, which is not a reason to refuse anything.
 */
export interface PeerCredential {
  readonly uid: number;
  /** Reusable, and therefore never an authorisation input. */
  readonly pid: number | undefined;
}

/**
 * The raw result of the two `getsockopt` calls, exactly as the kernel wrote them.
 *
 * `xucred` is `undefined` when `getsockopt(SOL_LOCAL, LOCAL_PEERCRED)` failed, and
 * otherwise holds the bytes it wrote, with `byteLength` equal to the `optlen` it
 * reported — so a short read is visible here and refused in `verifyPeer`.
 *
 * ## Where the `getsockopt` lives
 *
 * `bun:ffi` is gated to `@janela/pty` (docs/decisions/0021) and Bun 1.3 exposes no
 * peer-credential accessor, so the call is one more export on the PTY cdylib:
 *
 *   `jpty_peer_credential(fd: c_int, out: *mut u8, len: usize, out_pid: *mut i32) -> isize`
 *
 * It runs `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, out, &len)` and
 * `getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, …)`, returns the `optlen` the kernel
 * reported or `-errno`, and interprets nothing: the bytes cross untouched and are
 * read here. The listener that owns the accepted descriptor builds this value and
 * calls `verifyPeer` before reading the handshake. If Bun's socket API grows a
 * peer-credential accessor, use it and delete this note.
 */
export interface RawPeerCredential {
  readonly xucred: Uint8Array | undefined;
  readonly pid: number | undefined;
}

/** Why a peer was refused. Logged as a shape; never shown to the peer. */
export type PeerRefusal =
  /** `getsockopt` itself failed, so there is nothing to check. */
  | "credential-unavailable"
  /** Fewer than `XUCRED_BYTE_LENGTH` bytes: a partially filled struct. */
  | "credential-truncated"
  /** `cr_version` is not `XUCRED_VERSION`, so no field means what we think. */
  | "credential-version"
  /** A different user. */
  | "uid-mismatch";

export type PeerVerdict =
  | { readonly authorized: true; readonly credential: PeerCredential }
  | {
      readonly authorized: false;
      readonly refusal: PeerRefusal;
      /** For the log only, and `undefined` when `LOCAL_PEERPID` failed too. */
      readonly pid: number | undefined;
    };

/**
 * The uid rule on its own: the peer is us, or it is nobody. `pid` is not read.
 *
 * This is not an escalation boundary — a process running as the user could already
 * run anything as the user. It is the boundary that keeps a *different* user on a
 * shared Mac out. Same posture as tmux; see docs/decisions/0016-daemon-protocol.md.
 */
export function isAuthorized(credential: PeerCredential, ownUid: number): boolean {
  return credential.uid === ownUid;
}

function refuse(
  refusal: PeerRefusal,
  pid: number | undefined,
  log: Logger,
  peerUid?: number,
): PeerVerdict {
  // Ids and counts only: a refusal must be diagnosable on a shared machine
  // without the log becoming a record of who ran what.
  const fields: Record<string, string | number | boolean> = { refusal };
  if (pid !== undefined) {
    fields["pid"] = pid;
  }
  if (peerUid !== undefined) {
    fields["peerUid"] = peerUid;
  }
  log.notice("peer refused", fields);
  return { authorized: false, refusal, pid };
}

/**
 * Turns the raw `getsockopt` result into a verdict.
 *
 * The order of the checks is the security-relevant part: every refusal path
 * returns before `cr_uid` is read, so there is no way to obtain a
 * `PeerCredential` for a peer whose struct we did not first believe.
 */
export function verifyPeer(
  raw: RawPeerCredential,
  context: { readonly ownUid: number; readonly log: Logger },
): PeerVerdict {
  const { xucred, pid } = raw;

  if (xucred === undefined) {
    return refuse("credential-unavailable", pid, context.log);
  }

  // Structural, and therefore first: a two-byte buffer must never be indexed.
  // A *longer* struct is not refused here — it would carry a different
  // `cr_version`, which the next check catches.
  if (xucred.byteLength < XUCRED_BYTE_LENGTH) {
    return refuse("credential-truncated", pid, context.log);
  }

  // Little-endian is host order on both macOS architectures, and these are the
  // kernel's own bytes.
  const view = new DataView(xucred.buffer, xucred.byteOffset, xucred.byteLength);
  if (view.getUint32(0, true) !== XUCRED_VERSION) {
    return refuse("credential-version", pid, context.log);
  }

  const credential: PeerCredential = { uid: view.getUint32(4, true), pid };
  if (!isAuthorized(credential, context.ownUid)) {
    return refuse("uid-mismatch", pid, context.log, credential.uid);
  }

  const fields: Record<string, string | number | boolean> = { uid: credential.uid };
  if (pid !== undefined) {
    fields["pid"] = pid;
  }
  context.log.debug("peer verified", fields);
  return { authorized: true, credential };
}
