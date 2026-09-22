import { describe, expect, test } from "bun:test";

import { temporaryDirectory } from "@janela/test-support";
import type { Socket } from "bun";
import { Result, Schema } from "effect";

import type { NativePtyLibrary } from "./bindings.ts";
import {
  readPeerCredential,
  XUCRED_LENGTH,
  type RawPeerCredentialBytes,
} from "./peer-credential.ts";

interface ConnectedPair extends AsyncDisposable {
  readonly serverSideFd: number;
  readonly clientSideFd: number;
}

const SocketDescriptor = Schema.Struct({ fd: Schema.Number });

const decodeSocketDescriptor = Schema.decodeUnknownResult(SocketDescriptor);

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

function descriptorOf(socket: Socket<undefined>): number {
  const decoded = decodeSocketDescriptor(socket);

  if (Result.isFailure(decoded)) throw new Error("Bun's socket no longer exposes `fd`");

  return decoded.success.fd;
}

async function connectedPair(): Promise<ConnectedPair> {
  const directory = await temporaryDirectory("peer-credential");
  const path = directory.join("janelad.sock");
  const accepted = Promise.withResolvers<Socket<undefined>>();
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
    async [Symbol.asyncDispose](): Promise<void> {
      client.end();
      server.stop();
      await directory[Symbol.asyncDispose]();
    },
  };
}

function xucredOf(raw: RawPeerCredentialBytes): DataView {
  const bytes = raw.xucred;

  if (bytes === undefined) throw new Error("getsockopt reported no credential");

  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("readPeerCredential", () => {
  test("cr_version and cr_uid are the kernel's own bytes, not a zeroed buffer", async () => {
    await using pair = await connectedPair();

    const view = xucredOf(readPeerCredential(pair.serverSideFd));

    expect(view.getUint32(0, true)).toBe(0);
    expect(view.getUint32(4, true)).toBe(process.getuid?.() ?? -1);
  });

  test("the whole struct is filled, so verifyPeer's truncation check passes", async () => {
    await using pair = await connectedPair();

    expect(readPeerCredential(pair.serverSideFd).xucred?.byteLength).toBe(XUCRED_LENGTH);
  });

  test("the peer's pid is reported, which for a local pair is this process", async () => {
    await using pair = await connectedPair();

    expect(readPeerCredential(pair.clientSideFd).pid).toBe(process.pid);
  });

  test("a descriptor that is not a socket yields no credential rather than throwing", () => {
    expect(readPeerCredential(-1)).toEqual({ xucred: undefined, pid: undefined });
  });

  test("a short read is reported at the length the kernel filled, never padded", () => {
    const shortRead: NativePtyLibrary = { ...silentNative, jpty_peer_credential: () => 8n };

    expect(readPeerCredential(3, shortRead).xucred?.byteLength).toBe(8);
  });

  test("XUCRED_LENGTH matches @janela/daemon's copy, which is duplicated by hand", () => {
    expect(XUCRED_LENGTH).toBe(76);
  });
});
