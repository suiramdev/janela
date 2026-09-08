import { describe, expect, test } from "bun:test";

import { temporaryDirectory } from "@janela/test-support";

import type { NativePtyLibrary } from "./bindings.ts";
import {
  readPeerCredential,
  XUCRED_LENGTH,
  type RawPeerCredentialBytes,
} from "./peer-credential.ts";

/**
 * The descriptor behind a Bun socket.
 *
 * `fd` is a real property on Bun's socket and is missing from its type
 * declarations, so this narrows through `unknown` rather than asserting — and
 * throws a message naming the cause if a Bun upgrade removes it, instead of
 * failing as a mysterious `credential-unavailable`.
 */
function descriptorOf(socket: object): number {
  if ("fd" in socket && typeof socket.fd === "number") return socket.fd;
  throw new Error("Bun's socket no longer exposes `fd`");
}

/**
 * A real connected Unix socket pair, because the behaviour under test is what the
 * kernel says about a peer — the one thing a fake could not tell us.
 *
 * `Bun.listen`/`Bun.connect` rather than `node:net`: that module is gated to
 * `@janela/daemon` by `scripts/layers.ts`, and the gate scans this file too.
 */
async function connectedPair(): Promise<{
  readonly serverSideFd: number;
  readonly clientSideFd: number;
  close(): void;
}> {
  const directory = await temporaryDirectory("peer-credential");
  const path = directory.join("janelad.sock");
  const accepted = Promise.withResolvers<object>();

  const server = Bun.listen<undefined>({
    unix: path,
    socket: { open: (socket) => accepted.resolve(socket), data: () => {} },
  });
  const client = await Bun.connect<undefined>({
    unix: path,
    socket: { open: () => {}, data: () => {} },
  });
  const serverSide = await accepted.promise;

  return {
    serverSideFd: descriptorOf(serverSide),
    clientSideFd: descriptorOf(client),
    close: () => {
      client.end();
      server.stop();
      void directory[Symbol.asyncDispose]();
    },
  };
}

/** The `xucred`, or a failure naming what was missing. */
function xucredOf(raw: RawPeerCredentialBytes): DataView {
  const bytes = raw.xucred;
  if (bytes === undefined) throw new Error("getsockopt reported no credential");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * A native surface that answers "did nothing" to everything.
 *
 * Only `jpty_peer_credential` is overridden per test, and only where the kernel
 * cannot be made to produce the case.
 */
const silentNative: NativePtyLibrary = {
  jpty_spawn: () => -1,
  jpty_read: () => -1n,
  jpty_write: () => 0n,
  jpty_resize: () => 0,
  jpty_signal: () => 0,
  jpty_exit_code: () => 0,
  jpty_close: () => undefined,
  jpty_drop_all: () => 0,
  jpty_peer_credential: () => -1n,
};

describe("readPeerCredential", () => {
  test("reports the connecting process's uid, which is us", async () => {
    const pair = await connectedPair();
    try {
      // `struct xucred` is `{ u_int cr_version; uid_t cr_uid; short cr_ngroups; … }`
      // in native order. Asserting both fields proves the bytes reaching the
      // daemon are the kernel's, not a zeroed buffer.
      const view = xucredOf(readPeerCredential(pair.serverSideFd));

      expect(view.getUint32(0, true)).toBe(0);
      expect(view.getUint32(4, true)).toBe(process.getuid?.() ?? -1);
    } finally {
      pair.close();
    }
  });

  test("fills the whole struct, so verifyPeer's truncation check passes", async () => {
    const pair = await connectedPair();
    try {
      expect(readPeerCredential(pair.serverSideFd).xucred?.byteLength).toBe(XUCRED_LENGTH);
    } finally {
      pair.close();
    }
  });

  test("reports the peer's pid, which for a local pair is this process", async () => {
    const pair = await connectedPair();
    try {
      expect(readPeerCredential(pair.clientSideFd).pid).toBe(process.pid);
    } finally {
      pair.close();
    }
  });

  test("a descriptor that is not a socket yields no credential rather than throwing", () => {
    // Fail-closed: `verifyPeer` refuses this as `credential-unavailable`, which is
    // the only safe reading of "the kernel would not tell us who this is".
    expect(readPeerCredential(-1)).toEqual({ xucred: undefined, pid: undefined });
  });

  test("a short read is reported at the length the kernel filled, never padded", () => {
    // The kernel always fills the whole struct on a healthy socket, so the only
    // way to see the truncation path is to script the optlen. It matters:
    // `verifyPeer` refuses a short xucred as `credential-truncated`, and padding
    // it here would hand it a struct whose fields do not mean what they say.
    const shortRead: NativePtyLibrary = { ...silentNative, jpty_peer_credential: () => 8n };

    expect(readPeerCredential(3, shortRead).xucred?.byteLength).toBe(8);
  });

  test("the xucred length matches @janela/daemon's, which is duplicated by hand", () => {
    // The two constants cannot import each other — that edge points sideways — so
    // this pins the number on this side and the daemon's own test pins it there.
    expect(XUCRED_LENGTH).toBe(76);
  });
});
