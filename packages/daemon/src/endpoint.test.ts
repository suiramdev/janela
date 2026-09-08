import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { LogRecord, Logger } from "@janela/support";

import {
  MAXIMUM_SOCKET_PATH_LENGTH,
  SOCKET_DIRECTORY_MODE,
  SocketDirectoryUnsafe,
  SocketPathTooLong,
  XUCRED_BYTE_LENGTH,
  XUCRED_VERSION,
  defaultSocketPath,
  isAuthorized,
  verifyPeer,
  verifySocketDirectory,
} from "./endpoint.ts";

const OWN_UID = 501;
const OTHER_UID = 502;

interface Record_ {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

/**
 * A structural fake. `@janela/test-support`'s recording sink is global and
 * unimplemented; the logger here is injected, so a local fake is enough.
 */
function recordingLogger(): { logger: Logger; records: Record_[] } {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
      records.push({ level, message, fields });
    };
  return {
    logger: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
  };
}

/** A `struct xucred` as the kernel would write it: little-endian, host order. */
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

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "janela-endpoint-"));
  created.push(path);
  return path;
}

async function socketDirectory(mode: number): Promise<string> {
  const path = await temporaryDirectory();
  await chmod(path, mode);
  return path;
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
    // The rule the seam exists for: the returned path is short enough to bind.
    // A home directory long enough to break this throws instead, which is the
    // other half — and cannot be provoked without a seam this API deliberately
    // does not have.
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
    expect(verdict.refusal).toBe("credential-unavailable");
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
    expect(verdict.refusal).toBe("credential-truncated");
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
    expect(verdict.refusal).toBe("credential-truncated");
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
    expect(verdict.refusal).toBe("credential-version");
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
    expect(verdict.refusal).toBe("uid-mismatch");
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
    const directory = await socketDirectory(0o700);

    expect(() => {
      verifySocketDirectory(directory, currentUid());
    }).not.toThrow();
  });

  test("any other mode refuses to serve, and the summary stays clean", async () => {
    const directory = await socketDirectory(0o755);

    let thrown: unknown;
    try {
      verifySocketDirectory(directory, currentUid());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
    const error = thrown as SocketDirectoryUnsafe;
    expect(error.problem).toBe("wrong-mode");
    expect(error.mode).toBe(0o755);
    expect(error.reason).toContain("755");
    expect(error.reason).toContain("700");
    expect(error.summary).not.toContain("755");
    expect(error.summary).not.toContain(directory);
    expect(error.recoverySuggestion).toBeDefined();
  });

  test("a missing directory refuses to serve", async () => {
    const parent = await temporaryDirectory();

    let thrown: unknown;
    try {
      verifySocketDirectory(join(parent, "absent"), currentUid());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
    expect((thrown as SocketDirectoryUnsafe).problem).toBe("missing");
  });

  test("a file where the directory should be refuses to serve", async () => {
    const parent = await temporaryDirectory();
    const path = join(parent, "run");
    await writeFile(path, "");
    await chmod(path, 0o700);

    let thrown: unknown;
    try {
      verifySocketDirectory(path, currentUid());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
    expect((thrown as SocketDirectoryUnsafe).problem).toBe("not-a-directory");
  });

  test("a foreign owner refuses to serve", async () => {
    const directory = await socketDirectory(0o700);

    let thrown: unknown;
    try {
      verifySocketDirectory(directory, currentUid() + 1);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
    expect((thrown as SocketDirectoryUnsafe).problem).toBe("wrong-owner");
  });
});
