import { encodeFrame, frameDecoder, type Frame, type MessageTransport } from "@janela/protocol";
import { boundedQueue } from "@janela/support";

export interface WebSocketLike {
  binaryType: BinaryType;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(code: number | undefined, reason: string | undefined): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly wasClean: boolean }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WEB_SOCKET_PATH = "/ws";

export const INCOMING_MESSAGE_CAPACITY = 64;

export const SEND_BACKLOG_LIMIT_BYTES = 1024 * 1024;

const CLOSE_NORMAL = 1000;

const CLOSE_UNSUPPORTED_DATA = 1003;

const CLOSE_TRY_AGAIN_LATER = 1013;

export class WebSocketTransportFailure extends Error {
  constructor(reason: string) {
    super("the web socket failed");
    this.name = reason;
  }
}

export function webSocketURL(location: {
  readonly protocol: string;
  readonly host: string;
}): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";

  return `${scheme}//${location.host}${WEB_SOCKET_PATH}`;
}

export function openWebSocketTransport(
  url: string,
  create: WebSocketFactory = (target) => new WebSocket(target),
): Promise<MessageTransport> {
  const socket = create(url);
  socket.binaryType = "arraybuffer";

  const queue = boundedQueue<ArrayBuffer>({
    capacity: INCOMING_MESSAGE_CAPACITY,
    onOverflow: "block",
  });

  let opened = false;
  let closed = false;
  let failure: WebSocketTransportFailure | undefined;

  const fail = (reason: string, code: number): WebSocketTransportFailure => {
    const recorded = failure ?? new WebSocketTransportFailure(reason);
    failure = recorded;

    if (!closed) {
      closed = true;
      socket.close(code, reason);
    }

    return recorded;
  };

  const { promise, resolve, reject } = Promise.withResolvers<MessageTransport>();

  socket.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      fail("not-binary", CLOSE_UNSUPPORTED_DATA);

      return;
    }

    if (queue.size === queue.capacity) {
      fail("transport-stalled", CLOSE_TRY_AGAIN_LATER);

      return;
    }

    void queue.push(event.data);
  });

  socket.addEventListener("error", () => {
    failure ??= new WebSocketTransportFailure(opened ? "socket-failed" : "daemon-unavailable");
  });

  socket.addEventListener("close", (event) => {
    if (!opened) {
      failure ??= new WebSocketTransportFailure("daemon-unavailable");
      reject(failure);
    } else if (!event.wasClean) {
      failure ??= new WebSocketTransportFailure("socket-failed");
    }

    closed = true;
    queue.finish();
  });

  socket.addEventListener("open", () => {
    opened = true;

    resolve({
      async *incoming(): AsyncGenerator<Frame> {
        const decoder = frameDecoder();

        for await (const buffer of queue) {
          yield* decoder.push(new Uint8Array(buffer));
        }

        if (failure !== undefined) throw failure;

        decoder.end();
      },

      send(frame: Frame): Promise<void> {
        if (failure !== undefined) return Promise.reject(failure);

        if (closed) return Promise.reject(new WebSocketTransportFailure("transport-closed"));

        if (socket.bufferedAmount > SEND_BACKLOG_LIMIT_BYTES) {
          return Promise.reject(fail("transport-stalled", CLOSE_TRY_AGAIN_LATER));
        }

        socket.send(encodeFrame(frame));

        return Promise.resolve();
      },

      close(): Promise<void> {
        if (closed) return Promise.resolve();

        closed = true;
        socket.close(CLOSE_NORMAL, "client closed");

        return Promise.resolve();
      },
    });
  });

  return promise;
}
