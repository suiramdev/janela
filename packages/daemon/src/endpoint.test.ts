import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { temporaryDirectory, type TemporaryDirectory } from "@janela/test-support";
import { Effect, Predicate, Result } from "effect";

import {
  MAXIMUM_SOCKET_PATH_LENGTH,
  SOCKET_DIRECTORY_MODE,
  SocketDirectoryUnsafe,
  SocketPathTooLong,
  XUCRED_BYTE_LENGTH,
  XUCRED_VERSION,
  defaultSocketPath,
  isAuthorized,
  peerRefusalLabel,
  socketDirectoryProblemLabel,
  verifyPeer,
  verifySocketDirectory,
} from "./endpoint.ts";
import { recordingLogger } from "./test-fakes.ts";

const OWN_UID = 501;

const OTHER_UID = 502;

function xucred(options: {
  readonly uid: number;
  readonly version?: number;
  readonly byteLength?: number;
}): Uint8Array {
  const byteLength = options.byteLength ?? XUCRED_BYTE_LENGTH;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);

  if (byteLength >= 4) {
    view.setUint32(0, options.version ?? XUCRED_VERSION, true);
  }

  if (byteLength >= 8) {
    view.setUint32(4, options.uid, true);
  }

  return bytes;
}

function currentUid(): number {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error("POSIX only");
  }

  return uid;
}

async function socketDirectory(mode: number): Promise<TemporaryDirectory> {
  const directory = await temporaryDirectory("endpoint");
  await chmod(directory.path, mode);

  return directory;
}

function refusal(directory: string, ownUid: number): SocketDirectoryUnsafe {
  const attempted = Effect.runSync(
    Effect.result(
      Effect.try({
        try: () => {
          verifySocketDirectory(directory, ownUid);
        },
        catch: (cause) => cause,
      }),
    ),
  );

  return Result.match(attempted, {
    onSuccess: () => {
      throw new Error("expected verifySocketDirectory to refuse");
    },
    onFailure: (cause) => {
      if (cause instanceof SocketDirectoryUnsafe) return cause;

      throw cause;
    },
  });
}

describe("the socket endpoint", () => {
  test("sun_path is 104 bytes on macOS, which is why the socket is not in Application Support", () => {
    expect(MAXIMUM_SOCKET_PATH_LENGTH).toBe(104);
  });

  test("the socket directory is 0700 — anything that can connect can start processes", () => {
    expect(SOCKET_DIRECTORY_MODE).toBe(0o700);
  });

  test("a too-long path fails loudly, because a truncated sun_path silently addresses another socket", () => {
    const error = new SocketPathTooLong(120);

    expect(error.summary).not.toContain("sun_path");
    expect(error.reason).toContain("120");
    expect(error.reason).toContain("104");
    expect(error.recoverySuggestion).toBeDefined();
  });

  test("the default path is `~/.janela/run/janelad.sock` and fits sun_path", () => {
    const path = defaultSocketPath();

    expect(path.startsWith(`${homedir()}/`)).toBe(true);
    expect(path.endsWith("/.janela/run/janelad.sock")).toBe(true);
    expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(MAXIMUM_SOCKET_PATH_LENGTH);
  });
});

describe("peer verification", () => {
  test("a well-formed xucred for our uid is authorized and carries the pid", () => {
    const { logger, records } = recordingLogger();

    const verdict = verifyPeer(
      { xucred: xucred({ uid: OWN_UID }), pid: 4242 },
      { ownUid: OWN_UID, log: logger },
    );

    expect(verdict.authorized).toBe(true);

    if (!verdict.authorized) {
      throw new Error("expected an authorized verdict");
    }

    expect(verdict.credential.uid).toBe(OWN_UID);
    expect(verdict.credential.pid).toBe(4242);
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("debug");
    expect(records[0]?.message).toBe("peer verified");
    expect(records[0]?.fields?.["pid"]).toBe(4242);
  });

  test("a failed getsockopt refuses the connection", () => {
    const { logger, records } = recordingLogger();

    const verdict = verifyPeer({ xucred: undefined, pid: 7 }, { ownUid: OWN_UID, log: logger });

    expect(verdict.authorized).toBe(false);

    if (verdict.authorized) {
      throw new Error("expected a refusal");
    }

    expect(peerRefusalLabel(verdict.refusal)).toBe("credential-unavailable");
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("notice");
    expect(records[0]?.fields?.["refusal"]).toBe("credential-unavailable");
  });

  test("fewer bytes than sizeof(xucred) refuses, even when the visible fields look right", () => {
    const { logger } = recordingLogger();

    const verdict = verifyPeer(
      { xucred: xucred({ uid: OWN_UID, byteLength: XUCRED_BYTE_LENGTH - 1 }), pid: 7 },
      { ownUid: OWN_UID, log: logger },
    );

    expect(verdict.authorized).toBe(false);

    if (verdict.authorized) {
      throw new Error("expected a refusal");
    }

    expect(peerRefusalLabel(verdict.refusal)).toBe("credential-truncated");
    expect(
      Predicate.isTagged(verdict.refusal, "credential-truncated")
        ? verdict.refusal.received
        : undefined,
    ).toBe(XUCRED_BYTE_LENGTH - 1);
  });

  test("a two-byte credential is refused without reading a field", () => {
    const { logger } = recordingLogger();

    const verdict = verifyPeer(
      { xucred: new Uint8Array(2), pid: undefined },
      { ownUid: OWN_UID, log: logger },
    );

    expect(verdict.authorized).toBe(false);

    if (verdict.authorized) {
      throw new Error("expected a refusal");
    }

    expect(peerRefusalLabel(verdict.refusal)).toBe("credential-truncated");
  });

  test("cr_version is checked before the uid is believed", () => {
    const { logger, records } = recordingLogger();

    const verdict = verifyPeer(
      { xucred: xucred({ uid: OWN_UID, version: XUCRED_VERSION + 1 }), pid: 7 },
      { ownUid: OWN_UID, log: logger },
    );

    expect(verdict.authorized).toBe(false);

    if (verdict.authorized) {
      throw new Error("expected a refusal");
    }

    expect(peerRefusalLabel(verdict.refusal)).toBe("credential-version");
    expect(records[0]?.fields?.["peerUid"]).toBeUndefined();
  });

  test("a different uid is refused", () => {
    const { logger, records } = recordingLogger();

    const verdict = verifyPeer(
      { xucred: xucred({ uid: OTHER_UID }), pid: 4242 },
      { ownUid: OWN_UID, log: logger },
    );

    expect(verdict.authorized).toBe(false);

    if (verdict.authorized) {
      throw new Error("expected a refusal");
    }

    expect(peerRefusalLabel(verdict.refusal)).toBe("uid-mismatch");
    expect(verdict.pid).toBe(4242);
    expect(records[0]?.level).toBe("notice");
    expect(records[0]?.fields?.["peerUid"]).toBe(OTHER_UID);
    expect(records[0]?.fields?.["pid"]).toBe(4242);
  });

  test("the pid is recorded but never decides", () => {
    const refused = verifyPeer(
      { xucred: xucred({ uid: OTHER_UID }), pid: process.pid },
      { ownUid: OWN_UID, log: recordingLogger().logger },
    );

    expect(refused.authorized).toBe(false);

    const { logger, records } = recordingLogger();
    const authorized = verifyPeer(
      { xucred: xucred({ uid: OWN_UID }), pid: undefined },
      { ownUid: OWN_UID, log: logger },
    );

    expect(authorized.authorized).toBe(true);
    expect(records[0]?.fields).not.toHaveProperty("pid");
    expect(isAuthorized({ uid: OWN_UID, pid: 1 }, OWN_UID)).toBe(true);
    expect(isAuthorized({ uid: OTHER_UID, pid: process.pid }, OWN_UID)).toBe(false);
  });

  test("the layout constants are the measured macOS 26 values", () => {
    expect(XUCRED_BYTE_LENGTH).toBe(76);
    expect(XUCRED_VERSION).toBe(0);
  });
});

describe("the socket directory", () => {
  test("a 0700 directory we own is served", async () => {
    await using directory = await socketDirectory(0o700);

    expect(() => {
      verifySocketDirectory(directory.path, currentUid());
    }).not.toThrow();
  });

  test("any other mode refuses to serve, and the summary stays clean", async () => {
    await using directory = await socketDirectory(0o755);

    const error = refusal(directory.path, currentUid());

    expect(socketDirectoryProblemLabel(error.problem)).toBe("wrong-mode");
    expect(Predicate.isTagged(error.problem, "wrong-mode") ? error.problem.mode : undefined).toBe(
      0o755,
    );

    expect(error.reason).toContain("755");
    expect(error.reason).toContain("700");
    expect(error.summary).not.toContain("755");
    expect(error.summary).not.toContain(directory.path);
    expect(error.recoverySuggestion).toBeDefined();
  });

  test("a missing directory refuses to serve", async () => {
    await using directory = await temporaryDirectory("endpoint");

    const error = refusal(join(directory.path, "absent"), currentUid());

    expect(socketDirectoryProblemLabel(error.problem)).toBe("missing");
  });

  test("a file where the directory should be refuses to serve", async () => {
    await using directory = await temporaryDirectory("endpoint");
    const path = directory.join("run");
    await writeFile(path, "");
    await chmod(path, 0o700);

    const error = refusal(path, currentUid());

    expect(socketDirectoryProblemLabel(error.problem)).toBe("not-a-directory");
  });

  test("a foreign owner refuses to serve", async () => {
    await using directory = await socketDirectory(0o700);

    const error = refusal(directory.path, currentUid() + 1);

    expect(socketDirectoryProblemLabel(error.problem)).toBe("wrong-owner");
  });

  test("a permission error on the way to the directory is rethrown, not read as missing", async () => {
    await using directory = await temporaryDirectory("endpoint");
    const parent = directory.join("locked");
    await mkdir(join(parent, "run"), { recursive: true });
    await chmod(parent, 0o000);

    const attempted = Effect.runSync(
      Effect.result(
        Effect.try({
          try: () => {
            verifySocketDirectory(join(parent, "run"), currentUid());
          },
          catch: (cause) => cause,
        }),
      ),
    );

    expect(Result.isFailure(attempted)).toBe(true);
    expect(
      Result.match(attempted, {
        onSuccess: () => "served",
        onFailure: (cause) => (cause instanceof SocketDirectoryUnsafe ? "refused" : "rethrown"),
      }),
    ).toBe("rethrown");

    await chmod(parent, 0o700);
  });
});
