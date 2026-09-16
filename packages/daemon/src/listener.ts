import type { Server, Socket } from "node:net";

import {
  encodeDaemonMessage,
  encodeFrame,
  frameDecoder,
  type Frame,
  type MessageTransport,
} from "@janela/protocol";
import type { Logger } from "@janela/support";
import { Option, Result, Schema } from "effect";

import { errorName } from "./dispatch.ts";
import { verifyPeer, type RawPeerCredential } from "./endpoint.ts";
import type { AcceptedConnection, ConnectionListening } from "./server.ts";

export interface SocketListenerOptions {
  readonly server: Server;
  readonly credentials: (socket: Socket) => RawPeerCredential;
  readonly ownUid: number;
  readonly log: Logger;
}

export const PENDING_CONNECTION_CAPACITY = 16;

const UNAUTHORIZED = encodeFrame(
  encodeDaemonMessage({ type: "refused", refusal: { kind: "unauthorized" } }),
);

const CREDENTIAL_UNAVAILABLE: RawPeerCredential = { xucred: undefined, pid: undefined };

const decodePausedServer = Schema.decodeUnknownOption(
  Schema.Struct({ pauseOnConnect: Schema.Literal(true) }),
);

export function socketListener(options: SocketListenerOptions): ConnectionListening {
  const { server, credentials, ownUid, log } = options;

  if (Option.isNone(decodePausedServer(server))) {
    throw new Error("socketListener: create the server with { pauseOnConnect: true } (#43)");
  }

  const pending: Socket[] = [];
  let waiting: (() => void) | undefined;
  let closed = false;
  let accepting = false;

  server.on("connection", (socket: Socket) => {
    if (closed) {
      socket.destroy();

      return;
    }

    if (pending.length >= PENDING_CONNECTION_CAPACITY) {
      log.notice("connection backlog full", { pending: pending.length });
      socket.destroy();

      return;
    }

    pending.push(socket);

    const wake = waiting;
    waiting = undefined;
    wake?.();
  });

  const peerCredential = (socket: Socket): RawPeerCredential =>
    Result.match(Result.try({ try: () => credentials(socket), catch: errorName }), {
      onSuccess: (credential) => credential,
      onFailure: (error) => {
        log.debug("peer credential unavailable", { error });

        return CREDENTIAL_UNAVAILABLE;
      },
    });

  return {
    async *accept(): AsyncIterableIterator<AcceptedConnection> {
      if (accepting) throw new Error("one accept loop");

      accepting = true;

      // oxlint-disable-next-line no-unmodified-loop-condition
      while (!closed) {
        const socket = pending.shift();

        if (socket === undefined) {
          const { promise, resolve } = Promise.withResolvers<void>();
          waiting = resolve;
          // oxlint-disable-next-line no-await-in-loop
          await promise;

          continue;
        }

        const verdict = verifyPeer(peerCredential(socket), { ownUid, log });

        if (!verdict.authorized) {
          socket.write(UNAUTHORIZED);
          socket.end();

          continue;
        }

        yield { transport: socketTransport(socket), credential: verdict.credential };
      }
    },

    close(): Promise<void> {
      if (closed) return Promise.resolve();

      closed = true;
      server.close();

      for (const socket of pending.splice(0)) socket.destroy();

      const wake = waiting;
      waiting = undefined;
      wake?.();

      return Promise.resolve();
    },
  };
}

export function socketTransport(socket: Socket): MessageTransport {
  let closing = false;

  const inFlight = new Set<(error: Error) => void>();
  let failure: Error | undefined;

  const failEverything = (): void => {
    failure ??= new Error("transport closed");

    for (const reject of inFlight) reject(failure);

    inFlight.clear();
  };

  socket.once("close", failEverything);
  socket.once("error", failEverything);

  return {
    async *incoming(): AsyncIterableIterator<Frame> {
      const decoder = frameDecoder();
      const chunks: AsyncIterable<Uint8Array> = socket;

      for await (const chunk of chunks) {
        for (const frame of decoder.push(chunk)) yield frame;
      }

      decoder.end();
    },

    send(frame: Frame): Promise<void> {
      if (failure !== undefined) return Promise.reject(failure);

      if (socket.destroyed || closing) {
        return Promise.reject(new Error("transport closed"));
      }

      const { promise, resolve, reject } = Promise.withResolvers<void>();
      inFlight.add(reject);
      socket.write(encodeFrame(frame), (error) => {
        inFlight.delete(reject);

        if (error === undefined || error === null) resolve();
        else reject(error);
      });

      return promise;
    },

    close(): Promise<void> {
      if (closing) return Promise.resolve();

      closing = true;

      if (socket.writableLength === 0) socket.end();
      else socket.destroy();

      return Promise.resolve();
    },
  };
}
