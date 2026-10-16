import { connect, type Socket } from "node:net";

import { encodeFrame, frameDecoder, type Frame, type MessageTransport } from "@janela/protocol";
import { boundedQueue } from "@janela/support";
import { Option, Schema } from "effect";

export type SocketFactory = (path: string) => Socket;

export const INCOMING_CHUNK_CAPACITY = 64;

export const SEND_BACKLOG_LIMIT_BYTES = 1024 * 1024;

const decodeSystemErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

export class SocketTransportFailure extends Error {
  readonly code: string | undefined;

  constructor(reason: string, code: string | undefined = undefined) {
    super("the daemon socket failed");
    this.name = reason;
    this.code = code;
  }
}

function systemErrorCode(cause: unknown): string | undefined {
  return Option.getOrUndefined(Option.map(decodeSystemErrorCode(cause), ({ code }) => code));
}

export function openSocketTransport(
  path: string,
  open: SocketFactory = (target) => connect({ path: target }),
): Promise<MessageTransport> {
  const socket = open(path);

  const queue = boundedQueue<Uint8Array>({
    capacity: INCOMING_CHUNK_CAPACITY,
    onOverflow: "block",
  });

  let connected = false;
  let closed = false;
  let failure: SocketTransportFailure | undefined;

  const { promise, resolve, reject } = Promise.withResolvers<MessageTransport>();

  const fail = (reason: string): SocketTransportFailure => {
    const recorded = failure ?? new SocketTransportFailure(reason);
    failure = recorded;
    closed = true;
    socket.destroy();

    return recorded;
  };

  const resumeUnlessClosed = (): undefined => {
    if (!closed) socket.resume();

    return undefined;
  };

  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (queue.size < queue.capacity) {
      void queue.push(bytes);

      return;
    }

    socket.pause();
    void queue.push(bytes).then(resumeUnlessClosed);
  });

  socket.on("error", (cause: unknown) => {
    failure ??= new SocketTransportFailure(
      connected ? "socket-failed" : "daemon-unavailable",
      systemErrorCode(cause),
    );
  });

  socket.on("close", () => {
    closed = true;
    queue.finish();

    if (!connected) reject(failure ?? new SocketTransportFailure("daemon-unavailable"));
  });

  socket.on("connect", () => {
    connected = true;

    resolve({
      async *incoming(): AsyncGenerator<Frame> {
        const decoder = frameDecoder();

        for await (const bytes of queue) {
          yield* decoder.push(bytes);
        }

        if (failure !== undefined) throw failure;

        decoder.end();
      },

      send(frame: Frame): Promise<void> {
        if (failure !== undefined) return Promise.reject(failure);

        if (closed) return Promise.reject(new SocketTransportFailure("transport-closed"));

        if (socket.writableLength > SEND_BACKLOG_LIMIT_BYTES) {
          return Promise.reject(fail("transport-stalled"));
        }

        socket.write(encodeFrame(frame));

        return Promise.resolve();
      },

      close(): Promise<void> {
        if (closed) return Promise.resolve();

        closed = true;
        socket.end();

        return Promise.resolve();
      },
    });
  });

  return promise;
}
