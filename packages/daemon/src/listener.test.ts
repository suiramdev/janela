import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { connect, createServer } from "node:net";

import type { GridSize, TerminalID } from "@janela/core";
import {
  FrameKind,
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeFrame,
  frameDecoder,
  type DaemonMessage,
  type Frame,
  type RequestID,
} from "@janela/protocol";
import { temporaryDirectory } from "@janela/test-support";

import { MAXIMUM_SOCKET_PATH_LENGTH, XUCRED_BYTE_LENGTH, XUCRED_VERSION } from "./endpoint.ts";
import { socketListener } from "./listener.ts";
import { OUTPUT_QUEUE_CAPACITY, createDaemonServer, type DaemonServer } from "./server.ts";
import {
  clientHello,
  fakeDispatch,
  fakeProjects,
  fakeRegistry,
  fakeSession,
  fakeSessions,
  fakeTerminal,
  recordingLogger,
  type FakeDispatch,
  type FakeTerminal,
  type Recorded,
} from "./test-fakes.ts";

/**
 * The listener against a real Unix socket.
 *
 * Framing across arbitrary chunk boundaries, a peer that goes away mid-frame, and
 * back-pressure from a socket nobody is reading are exactly what an in-process
 * transport cannot tell us, so these tests pay for a real one.
 */

const REQUEST_ID = 1 as RequestID;
const VIEWPORT: GridSize = { columns: 80, rows: 24 };

const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;

async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    // Polling is the point: the condition is what the test waits for, and each
    // check has to happen after the previous one.
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** A `struct xucred` as the kernel would write it: little-endian, host order. */
function xucred(uid: number): Uint8Array {
  const bytes = new Uint8Array(XUCRED_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, XUCRED_VERSION, true);
  view.setUint32(4, uid, true);
  return bytes;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("POSIX only");
  return uid;
}

/** A client on the real socket, framing by hand. */
interface SocketClient {
  readonly frames: Frame[];
  controls(): DaemonMessage[];
  outputs(): { readonly terminalID: TerminalID; readonly text: string }[];
  write(frame: Frame): void;
  /** Raw bytes, so a test can split a frame wherever it likes. */
  writeBytes(bytes: Uint8Array): void;
  /** Stops reading, so the kernel buffer fills and the daemon feels it. */
  stopReading(): void;
  ended(): boolean;
  finish(): void;
  destroy(): void;
}

async function socketClient(path: string): Promise<SocketClient> {
  const socket = connect(path);
  await once(socket, "connect");

  const decoder = frameDecoder();
  const text = new TextDecoder();
  const frames: Frame[] = [];
  let finished = false;

  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      // The decoder hands out views into its own buffer, valid only until the
      // next push. This test keeps them, so it copies them.
      frames.push({ kind: frame.kind, payload: Uint8Array.from(frame.payload) });
    }
  });
  socket.on("close", () => {
    finished = true;
  });
  socket.on("error", () => {
    finished = true;
  });

  return {
    frames,
    controls: () =>
      frames.filter((frame) => frame.kind === FrameKind.Control).map(decodeDaemonMessage),
    outputs: () =>
      frames
        .filter((frame) => frame.kind === FrameKind.Output)
        .map((frame) => {
          const output = decodeOutput(frame);
          return { terminalID: output.terminalID, text: text.decode(output.bytes) };
        }),
    write: (frame) => {
      socket.write(encodeFrame(frame));
    },
    writeBytes: (bytes) => {
      socket.write(bytes);
    },
    stopReading: () => {
      socket.pause();
    },
    ended: () => finished,
    finish: () => {
      socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
  };
}

interface Fixture {
  readonly path: string;
  readonly daemon: DaemonServer;
  readonly dispatch: FakeDispatch;
  readonly records: Recorded[];
  with(message: string): Recorded[];
  connect(): Promise<SocketClient>;
  stop(): Promise<void>;
}

const running: Fixture[] = [];
const clients: SocketClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(running.splice(0).map((active) => active.stop()));
});

async function fixture(
  options: {
    readonly terminals?: readonly FakeTerminal[];
    /** What the injected `getsockopt` reader reports. Defaults to us. */
    readonly peerUid?: number;
  } = {},
): Promise<Fixture> {
  const directory = await temporaryDirectory("listener");
  const path = directory.join("d.sock");
  // A truncated `sun_path` silently addresses a different socket, so the fixture
  // asserts its own path fits before it binds.
  expect(Buffer.byteLength(path)).toBeLessThan(MAXIMUM_SOCKET_PATH_LENGTH);

  const server = createServer();
  server.listen(path);
  await once(server, "listening");

  const registry = fakeRegistry(options.terminals ?? []);
  const dispatch = fakeDispatch(registry);
  const { logger, records, with: withMessage } = recordingLogger();
  const ownUid = currentUid();
  const controller = new AbortController();

  const daemon = createDaemonServer({
    sessions: fakeSessions(),
    projects: fakeProjects(),
    terminals: registry,
    log: logger,
    dispatch,
    handshakeDeadlineMs: 500,
  });

  const listener = socketListener({
    server,
    credentials: () => ({ xucred: xucred(options.peerUid ?? ownUid), pid: 7 }),
    ownUid,
    log: logger,
  });

  const serving = daemon.serve(listener, controller.signal);

  const value: Fixture = {
    path,
    daemon,
    dispatch,
    records,
    with: withMessage,
    async connect(): Promise<SocketClient> {
      const client = await socketClient(path);
      clients.push(client);
      return client;
    },
    async stop(): Promise<void> {
      controller.abort();
      await serving;
      await directory[Symbol.asyncDispose]();
    },
  };

  running.push(value);
  return value;
}

const subscribeToState = (): Frame =>
  encodeClientMessage({ type: "subscribe", id: REQUEST_ID, scope: { kind: "state" } });

/** Handshakes and returns the client once the daemon has answered. */
async function connectAndHandshake(daemon: Fixture): Promise<SocketClient> {
  const client = await daemon.connect();
  client.write(clientHello());
  await until(() => client.controls().length > 0, "the daemon's hello");
  return client;
}

describe("the socket listener", () => {
  test("a hello split inside its length prefix still arrives, and the connection works", async () => {
    const daemon = await fixture();
    const client = await daemon.connect();

    const bytes = encodeFrame(clientHello());
    // Three bytes is inside the four-byte length prefix: a reader that assumes a
    // frame arrives whole fails exactly here.
    client.writeBytes(bytes.subarray(0, 3));
    await Bun.sleep(10);
    client.writeBytes(bytes.subarray(3));

    await until(() => client.controls().length === 1, "the daemon's hello");
    expect(client.controls()[0]?.type).toBe("hello");

    client.write(subscribeToState());
    await until(() => client.controls().length === 2, "the acknowledgement");
    expect(client.controls()[1]).toEqual({ type: "acknowledged", id: REQUEST_ID });
    expect(daemon.daemon.connectionCount).toBe(1);
  });

  test("a peer belonging to another user is refused before the handshake is read", async () => {
    const ownUid = currentUid();
    const daemon = await fixture({ peerUid: ownUid + 1 });
    const client = await daemon.connect();

    await until(() => client.frames.length === 1, "the refusal");
    expect(client.controls()[0]).toEqual({
      type: "refused",
      refusal: { kind: "unauthorized" },
    });
    await until(() => client.ended(), "the socket to close");

    expect(daemon.daemon.connectionCount).toBe(0);
    expect(daemon.with("peer refused")[0]?.fields?.["refusal"]).toBe("uid-mismatch");
    // The refusal says nothing about which check failed.
    expect(client.controls()[0]).not.toHaveProperty("refusal.peerUid");
  });

  test("a peer that goes away mid-frame costs its own connection and no other", async () => {
    const daemon = await fixture();
    const healthy = await connectAndHandshake(daemon);
    healthy.write(subscribeToState());
    await until(() => daemon.dispatch.requests.length === 1, "the subscription");

    const truncated = await connectAndHandshake(daemon);
    // A length prefix claiming a payload that never comes, then FIN.
    truncated.writeBytes(new Uint8Array([0, 0, 0, 8, FrameKind.Control, 1, 2]));
    truncated.finish();

    await until(() => daemon.with("connection failed").length === 1, "the failure to be noticed");
    expect(daemon.with("connection failed")[0]?.fields?.["error"]).toBe("truncated");
    await until(() => daemon.daemon.connectionCount === 1, "the survivor to be the only one left");

    const session = fakeSession("s1");
    await daemon.daemon.sessionsChanged([session]);
    await until(
      () => healthy.controls().some((message) => message.type === "state"),
      "the survivor's state update",
    );
  });

  test("a peer that stops reading its socket bounds its own memory and delays nobody", async () => {
    // 64 KB deltas: big enough that the kernel buffer fills within a few frames.
    const big = new Uint8Array(64 * 1024).fill(0x61);
    const terminal = fakeTerminal(terminalID(), { delta: big, full: big });
    const daemon = await fixture({ terminals: [terminal] });

    const reader = await connectAndHandshake(daemon);
    reader.write(subscribeToState());
    await until(() => daemon.dispatch.requests.length === 1, "the subscription");

    const stalled = await connectAndHandshake(daemon);
    stalled.write(
      encodeClientMessage({
        type: "attach",
        id: REQUEST_ID,
        terminalID: terminal.id,
        viewport: VIEWPORT,
      }),
    );
    await until(() => terminal.attached.size === 1, "the viewport to register");
    stalled.stopReading();

    for (let index = 0; index < 200; index += 1) {
      daemon.daemon.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    const encodes = terminal.repaintCalls.length + terminal.fullRepaintCalls.length;
    // The bound is the queue plus what the socket itself took, not 200.
    expect(encodes).toBeLessThan(60);

    const started = Bun.nanoseconds();
    await daemon.daemon.sessionsChanged([fakeSession("s1")]);
    await until(
      () => reader.controls().some((message) => message.type === "state"),
      "the reading client's state update",
    );
    // Two hundred frames owed to a peer that is not reading, and the other client
    // is still served promptly.
    expect(Bun.nanoseconds() - started).toBeLessThan(200_000_000);
    expect(daemon.daemon.connectionCount).toBe(2);
    expect(terminal.stopCalls.count).toBe(0);
  });

  test("aborting stops the listener, and a later connect is refused by the OS", async () => {
    const daemon = await fixture();
    const client = await connectAndHandshake(daemon);

    await daemon.stop();
    await until(() => client.ended(), "the client's socket to close");

    const late = connect(daemon.path);
    const [error] = (await once(late, "error")) as [NodeJS.ErrnoException];
    expect(["ECONNREFUSED", "ENOENT"]).toContain(error.code ?? "none");
  });

  test("the output bound is what the queue says, not what the socket accepted", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = await fixture({ terminals: [terminal] });
    const client = await connectAndHandshake(daemon);

    client.write(
      encodeClientMessage({
        type: "attach",
        id: REQUEST_ID,
        terminalID: terminal.id,
        viewport: VIEWPORT,
      }),
    );
    await until(() => terminal.attached.size === 1, "the viewport to register");

    for (let index = 0; index < OUTPUT_QUEUE_CAPACITY; index += 1) {
      daemon.daemon.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    // A reading client receives every frame; the bound only bites when it stops.
    await until(
      () => client.outputs().length >= OUTPUT_QUEUE_CAPACITY,
      "every frame to reach a reading client",
    );
    expect(client.outputs()[0]?.text).toBe("F");
    expect(client.outputs()[0]?.terminalID).toBe(terminal.id);
  });
});
