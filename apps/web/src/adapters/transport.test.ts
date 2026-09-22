import { describe, expect, test } from "bun:test";

import {
  FrameError,
  FrameKind,
  TruncatedFrame,
  encodeFrame,
  type Frame,
  type MessageTransport,
} from "@janela/protocol";
import { Effect, Result } from "effect";

import {
  INCOMING_MESSAGE_CAPACITY,
  SEND_BACKLOG_LIMIT_BYTES,
  WEB_SOCKET_PATH,
  WebSocketTransportFailure,
  openWebSocketTransport,
  webSocketURL,
  type WebSocketLike,
} from "./transport.ts";

interface Closure {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

interface Listeners {
  readonly open: (() => void)[];
  readonly message: ((event: { readonly data: ArrayBuffer | string }) => void)[];
  readonly close: ((event: { readonly wasClean: boolean }) => void)[];
  readonly error: (() => void)[];
}

type Registration =
  | ["open", () => void]
  | ["message", (event: { readonly data: unknown }) => void]
  | ["close", (event: { readonly wasClean: boolean }) => void]
  | ["error", () => void];

interface FakeSocket extends WebSocketLike {
  readonly url: string;
  readonly sent: Uint8Array[];
  readonly closures: Closure[];
  bufferedAmount: number;
  open(): void;
  message(data: ArrayBuffer | string): void;
  error(): void;
  close(code: number | undefined, reason: string | undefined): void;
  closedBy(wasClean: boolean): void;
}

const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x80, 0xc3, 0x28]);

const outputFrame: Frame = { kind: FrameKind.Output, payload: NOT_UTF8 };

const controlFrame: Frame = { kind: FrameKind.Control, payload: new TextEncoder().encode("{}") };

function fakeSocket(url: string): FakeSocket {
  const sent: Uint8Array[] = [];
  const closures: Closure[] = [];
  const listeners: Listeners = { open: [], message: [], close: [], error: [] };

  return {
    url,
    sent,
    closures,
    binaryType: "blob",
    bufferedAmount: 0,
    send(data: Uint8Array): void {
      sent.push(data.slice());
    },
    close(code: number | undefined, reason: string | undefined): void {
      closures.push({ code, reason });
    },
    addEventListener(...registration: Registration): void {
      if (registration[0] === "open") listeners.open.push(registration[1]);
      else if (registration[0] === "message") listeners.message.push(registration[1]);
      else if (registration[0] === "close") listeners.close.push(registration[1]);
      else listeners.error.push(registration[1]);
    },
    open: () => {
      for (const listener of listeners.open) listener();
    },
    message: (data) => {
      for (const listener of listeners.message) listener({ data });
    },
    error: () => {
      for (const listener of listeners.error) listener();
    },
    closedBy: (wasClean) => {
      for (const listener of listeners.close) listener({ wasClean });
    },
  };
}

async function drain(transport: MessageTransport): Promise<Result.Result<Frame[], unknown>> {
  return await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: async () => {
          const frames: Frame[] = [];

          for await (const frame of transport.incoming()) {
            frames.push({ kind: frame.kind, payload: frame.payload.slice() });
          }

          return frames;
        },
        catch: (cause) => cause,
      }),
    ),
  );
}

async function opened(): Promise<{ socket: FakeSocket; transport: MessageTransport }> {
  let socket: FakeSocket | undefined;
  const pending = openWebSocketTransport("ws://gateway.test/ws", (url) => {
    socket = fakeSocket(url);

    return socket;
  });

  if (socket === undefined) throw new Error("the factory was not called");

  socket.open();

  return { socket, transport: await pending };
}

function nameOf(result: Result.Result<unknown, unknown>): string | undefined {
  if (Result.isSuccess(result)) return undefined;

  return result.failure instanceof Error ? result.failure.name : undefined;
}

describe("webSocketURL", () => {
  test("follows the page's scheme and host", () => {
    expect(webSocketURL({ protocol: "http:", host: "localhost:1421" })).toBe(
      `ws://localhost:1421${WEB_SOCKET_PATH}`,
    );

    expect(webSocketURL({ protocol: "https:", host: "mac.tail.ts.net" })).toBe(
      `wss://mac.tail.ts.net${WEB_SOCKET_PATH}`,
    );
  });
});

describe("openWebSocketTransport", () => {
  test("asks for binary frames at the URL it was given", async () => {
    const { socket } = await opened();

    expect(socket.url).toBe("ws://gateway.test/ws");
    expect(socket.binaryType).toBe("arraybuffer");
  });

  test("a socket that closes before opening is the daemon being unavailable", async () => {
    let socket: FakeSocket | undefined;
    const pending = openWebSocketTransport("ws://gateway.test/ws", (url) => {
      socket = fakeSocket(url);

      return socket;
    });

    socket?.error();
    socket?.closedBy(false);

    const thrown = await pending.then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(WebSocketTransportFailure);

    if (thrown instanceof Error) expect(thrown.name).toBe("daemon-unavailable");
  });

  test("sends one encoded frame per message", async () => {
    const { socket, transport } = await opened();

    await transport.send(outputFrame);
    await transport.send(controlFrame);

    expect(socket.sent).toEqual([encodeFrame(outputFrame), encodeFrame(controlFrame)]);
  });

  test("one message carrying two frames yields both", async () => {
    const { socket, transport } = await opened();
    const both = new Uint8Array([...encodeFrame(outputFrame), ...encodeFrame(controlFrame)]);

    socket.message(both.buffer);
    socket.closedBy(true);

    const drained = await drain(transport);

    expect(Result.isSuccess(drained) ? drained.success : undefined).toEqual([
      outputFrame,
      controlFrame,
    ]);
  });

  test("a frame split over two messages is one frame", async () => {
    const { socket, transport } = await opened();
    const encoded = encodeFrame(outputFrame);

    socket.message(encoded.slice(0, 3).buffer);
    socket.message(encoded.slice(3).buffer);
    socket.closedBy(true);

    const drained = await drain(transport);

    expect(Result.isSuccess(drained) ? drained.success : undefined).toEqual([outputFrame]);
  });

  test("a text message is a protocol violation, closed as unsupported data", async () => {
    const { socket, transport } = await opened();

    socket.message("hello");
    socket.closedBy(true);

    const drained = await drain(transport);

    expect(nameOf(drained)).toBe("not-binary");
    expect(socket.closures).toEqual([{ code: 1003, reason: "not-binary" }]);
  });

  test("a consumer that stops reading is cut off rather than buffered without bound", async () => {
    const { socket, transport } = await opened();
    const encoded = encodeFrame(outputFrame);

    for (let index = 0; index <= INCOMING_MESSAGE_CAPACITY; index += 1) {
      socket.message(encoded.slice().buffer);
    }

    socket.closedBy(false);

    const drained = await drain(transport);

    expect(nameOf(drained)).toBe("transport-stalled");
    expect(socket.closures).toEqual([{ code: 1013, reason: "transport-stalled" }]);
    expect(Result.isFailure(drained)).toBe(true);
  });

  test("a clean close ends the stream, and a close mid-frame is truncation", async () => {
    const clean = await opened();
    clean.socket.closedBy(true);

    expect(Result.isSuccess(await drain(clean.transport))).toBe(true);

    const torn = await opened();
    torn.socket.message(encodeFrame(outputFrame).slice(0, 3).buffer);
    torn.socket.closedBy(true);

    const drained = await drain(torn.transport);
    const thrown = Result.isFailure(drained) ? drained.failure : undefined;

    expect(thrown).toBeInstanceOf(FrameError);

    if (thrown instanceof FrameError) expect(thrown.reason).toBeInstanceOf(TruncatedFrame);
  });

  test("an unclean close is the socket failing", async () => {
    const { socket, transport } = await opened();

    socket.error();
    socket.closedBy(false);

    expect(nameOf(await drain(transport))).toBe("socket-failed");
  });

  test("sending after the peer went away is refused", async () => {
    const { socket, transport } = await opened();

    socket.closedBy(true);

    const thrown = await transport.send(outputFrame).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(WebSocketTransportFailure);

    if (thrown instanceof Error) expect(thrown.name).toBe("transport-closed");
  });

  test("a send backlog past the bound closes the socket instead of growing it", async () => {
    const { socket, transport } = await opened();
    socket.bufferedAmount = SEND_BACKLOG_LIMIT_BYTES + 1;

    const thrown = await transport.send(outputFrame).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    if (thrown instanceof Error) expect(thrown.name).toBe("transport-stalled");

    expect(socket.sent).toEqual([]);
    expect(socket.closures).toEqual([{ code: 1013, reason: "transport-stalled" }]);
  });

  test("closing is idempotent and normal", async () => {
    const { socket, transport } = await opened();

    await transport.close();
    await transport.close();

    expect(socket.closures).toEqual([{ code: 1000, reason: "client closed" }]);
  });
});
