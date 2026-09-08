import type { Server, Socket } from "node:net";

import {
  encodeDaemonMessage,
  encodeFrame,
  frameDecoder,
  type Frame,
  type MessageTransport,
} from "@janela/protocol";
import type { Logger } from "@janela/support";

import { verifyPeer, type RawPeerCredential } from "./endpoint.ts";
import type { AcceptedConnection, ConnectionListening } from "./server.ts";

/**
 * The Unix-socket listener and its transport.
 *
 * The only file in Janela that names `node:net`. Everything above it works
 * against `ConnectionListening` and `MessageTransport`, which is what lets the
 * server's own tests run in-process and a future WebSocket client be a transport
 * rather than a rewrite (ADR 0016, ADR 0023).
 */

/**
 * Accepted-but-unverified sockets held while the accept loop is busy.
 *
 * Every one of these costs a descriptor and can be opened by anything that can
 * reach the socket, so the backlog we keep in *userland* is bounded and the
 * kernel's own backlog does the rest. Sixteen is far more than a machine with a
 * handful of clients ever queues.
 */
export const PENDING_CONNECTION_CAPACITY = 16;

export interface SocketListenerOptions {
  /**
   * Bound and listening already: the descriptor launchd handed us, wrapped by
   * `apps/daemon`, or a path bound for `--foreground`.
   *
   * This package never binds and never chooses a path, because launchd owns the
   * socket (ADR 0017). Whoever binds calls `verifySocketDirectory` first.
   */
  readonly server: Server;
  /**
   * The two `getsockopt` calls, run by whoever can reach the descriptor.
   *
   * Injected rather than called here: `bun:ffi` is gated to `@janela/pty`
   * (ADR 0021) and Bun exposes no peer-credential accessor, so the real reader is
   * a native export the composition root supplies — see `RawPeerCredential`. A
   * reader that throws is treated as `{ xucred: undefined, pid: undefined }`,
   * which `verifyPeer` refuses as `credential-unavailable`.
   */
  readonly credentials: (socket: Socket) => RawPeerCredential;
  readonly ownUid: number;
  readonly log: Logger;
}

/** Sent to a peer that is not us, before its socket is closed. */
const UNAUTHORIZED = encodeFrame(
  encodeDaemonMessage({ type: "refused", refusal: { kind: "unauthorized" } }),
);

export function socketListener(options: SocketListenerOptions): ConnectionListening {
  const { server, credentials, ownUid, log } = options;

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
      // Shedding is the bound: a peer that cannot be served now is better off
      // reconnecting than sitting in an unbounded queue.
      log.notice("connection backlog full", { pending: pending.length });
      socket.destroy();
      return;
    }
    pending.push(socket);
    const wake = waiting;
    waiting = undefined;
    wake?.();
  });

  return {
    async *accept(): AsyncIterableIterator<AcceptedConnection> {
      if (accepting) throw new Error("one accept loop");
      accepting = true;

      // `closed` is set by `close()`, which also wakes the parked waiter below.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (!closed) {
        const socket = pending.shift();
        if (socket === undefined) {
          const { promise, resolve } = Promise.withResolvers<void>();
          waiting = resolve;
          // Parking until a connection arrives is the whole job of an accept
          // loop; there is nothing to run in parallel with it.
          // oxlint-disable-next-line no-await-in-loop
          await promise;
          continue;
        }

        let raw: RawPeerCredential;
        try {
          raw = credentials(socket);
        } catch (error) {
          // A failed read is not a refusal reason of its own: `verifyPeer` has
          // one, and it logs it.
          log.debug("peer credential unavailable", {
            error: error instanceof Error ? error.name : "unknown",
          });
          raw = { xucred: undefined, pid: undefined };
        }

        const verdict = verifyPeer(raw, { ownUid, log });
        if (!verdict.authorized) {
          // `verifyPeer` has already logged the refusal shape. The peer is told
          // it is unauthorized and nothing else — never which check failed.
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
      // Not awaited: `server.close`'s callback waits for every accepted socket,
      // and the ones we accepted are closed by the server's own shutdown.
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

  /**
   * Rejections for writes still in flight.
   *
   * A socket that is destroyed with a write outstanding does not reliably call
   * that write's callback, and a pump waiting on a promise nobody will settle is
   * a connection that never finishes closing. One pair of listeners for the
   * socket's life rather than a pair per frame, because this is the hot path.
   */
  const inFlight = new Set<(error: Error) => void>();
  let failure: Error | undefined;

  const failEverything = (): void => {
    failure ??= new Error("transport closed");
    for (const reject of inFlight) reject(failure);
    inFlight.clear();
  };
  socket.once("close", failEverything);
  // Also keeps a socket error from being an unhandled `error` event, which would
  // take the daemon down over one peer's connection.
  socket.once("error", failEverything);

  return {
    /**
     * Frames as they arrive.
     *
     * Yielded frames are *views* into the chunk or the decoder's buffer, valid
     * only until the next `push` — which cannot happen while the consumer holds
     * one, because the next chunk is read only when it asks for the next frame.
     *
     * @throws {FrameError} `truncated` when the peer went away mid-frame, and
     * whatever the socket threw when it failed. Both are the connection's problem
     * and nobody else's.
     */
    async *incoming(): AsyncIterableIterator<Frame> {
      const decoder = frameDecoder();
      for await (const chunk of socket) {
        // `Buffer` is a `Uint8Array`; no copy, no conversion.
        for (const frame of decoder.push(chunk as Uint8Array)) yield frame;
      }
      decoder.end();
    },

    /**
     * Writes one frame, resolving when the socket has taken it.
     *
     * The write callback is the back-pressure: with a peer that has stopped
     * reading, it does not fire until the kernel buffer drains, so at most one
     * frame plus the socket's high-water mark sits in this process. Concurrent
     * sends are ordered by `socket.write` itself, which is what lets the control
     * and output pumps write to the same socket.
     */
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
      if (socket.writableLength === 0) {
        // Nothing outstanding: FIN, and the peer reads what the kernel holds.
        socket.end();
      } else {
        // The peer is not reading what we already wrote; there is nothing to
        // preserve by waiting for it.
        socket.destroy();
      }
      return Promise.resolve();
    },
  };
}
