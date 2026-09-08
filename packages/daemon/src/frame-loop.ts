import type { TerminalID } from "@janela/core";
import type { Logger } from "@janela/support";
import type { TerminalRegistry } from "@janela/terminal";

/**
 * The daemon's heartbeat: once per frame, drain every live terminal and send each
 * attached client the repaint it is owed.
 *
 * This is the shape ADR 0003 called "socket writes are coalesced once per frame,
 * per attached client", and it is the reason a `yes` flood never reaches a client.
 * Measured in the migration spikes: 132 MB/s off the PTY becomes a bounded number
 * of frames per second on the socket, and the event loop stayed within 2 ms of its
 * interval throughout.
 *
 * Three rules, all of them load-bearing:
 *
 * 1. **One drain per terminal per frame, N encodes.** Draining per attached client
 *    would multiply the work by the number of windows.
 * 2. **A slow client applies back-pressure to its own stream and nothing else.** A
 *    phone on a bad connection must not slow down the Mac's window.
 * 3. **Nothing here is per-byte.** The frame loop touches counters and buffer
 *    views; anything that allocates per byte or per frame belongs somewhere else,
 *    and docs/performance.md has the budget it would break.
 */
export interface FrameLoop {
  /**
   * Runs a frame on the interval until `signal` aborts.
   *
   * The interval exists only while something is attached: a daemon holding forty
   * idle terminals with no client attached costs no wakeups at all (non-negotiable
   * #5). `attach` arms it, the last `detach` drops it.
   */
  start(signal: AbortSignal): void;
  /** Frame interval. One frame at 120 Hz; tuned against a benchmark, not argued about. */
  readonly intervalMs: number;
  /** One frame, synchronously. `start` runs it on the interval; tests call it directly. */
  tick(): void;
  /**
   * Registers a (client, terminal) pair, owing it a full repaint first.
   *
   * Idempotent in shape and not in effect: calling it again re-owes the full
   * repaint, which is how a client whose output queue dropped frames recovers.
   */
  attach(client: string, terminalID: TerminalID): void;
  detach(client: string, terminalID: TerminalID): void;
  /** The connection went away. */
  detachAll(client: string): void;
}

/** One frame at 120 Hz — the same window `@janela/pty` coalesces reads into. */
export const FRAME_INTERVAL_MS = 8;

/** What one attached client is owed on the next frame. */
interface Attachment {
  /** A full repaint, because it has just attached or it missed deltas. */
  full: boolean;
}

export function createFrameLoop(dependencies: {
  readonly terminals: TerminalRegistry;
  /**
   * Whether `client`'s output queue can take one more frame.
   *
   * Consulted *before* the encode, so a stalled client costs no encode work — and
   * a client with no room is re-owed a full repaint, because a dropped delta is
   * incremental and the next delta does not supersede it.
   */
  readonly hasRoom: (client: string) => boolean;
  readonly deliver: (client: string, terminalID: TerminalID, bytes: Uint8Array) => void;
  readonly log: Logger;
}): FrameLoop {
  const { terminals, hasRoom, deliver, log } = dependencies;

  /** Terminal → its attached clients. Empty means the loop has nothing to do. */
  const attachments = new Map<TerminalID, Map<string, Attachment>>();
  let timer: Timer | undefined;
  /** Whether `start` has been called and its signal has not aborted. */
  let armed = false;

  const loop: FrameLoop = {
    intervalMs: FRAME_INTERVAL_MS,

    start(signal: AbortSignal): void {
      armed = true;
      if (attachments.size > 0 && timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }
      signal.addEventListener(
        "abort",
        () => {
          armed = false;
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        },
        { once: true },
      );
    },

    tick(): void {
      for (const [terminalID, clients] of attachments) {
        const terminal = terminals.get(terminalID);
        if (terminal === undefined) {
          // Gone from the registry: the session layer owns that transition and
          // has already told the clients. Deleting during iteration is defined.
          attachments.delete(terminalID);
          continue;
        }

        for (const [client, attachment] of clients) {
          if (!hasRoom(client)) {
            attachment.full = true;
            continue;
          }

          let bytes: Uint8Array;
          try {
            bytes = attachment.full ? terminal.fullRepaintFor(client) : terminal.repaintFor(client);
          } catch (error) {
            // The terminal is lost, not the connection: stop asking it for
            // repaints and leave its state to the registry.
            log.warning("repaint failed", {
              terminalID,
              client,
              error: error instanceof Error ? error.name : "unknown",
            });
            attachments.delete(terminalID);
            break;
          }

          attachment.full = false;
          // Nothing changed is the common case, and it sends nothing.
          if (bytes.length > 0) deliver(client, terminalID, bytes);
        }
      }

      if (attachments.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    attach(client: string, terminalID: TerminalID): void {
      let clients = attachments.get(terminalID);
      if (clients === undefined) {
        clients = new Map<string, Attachment>();
        attachments.set(terminalID, clients);
      }
      clients.set(client, { full: true });
      if (armed && timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }
    },

    detach(client: string, terminalID: TerminalID): void {
      const clients = attachments.get(terminalID);
      if (clients === undefined) return;
      clients.delete(client);
      if (clients.size === 0) attachments.delete(terminalID);
      if (attachments.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    detachAll(client: string): void {
      for (const [terminalID, clients] of attachments) {
        clients.delete(client);
        if (clients.size === 0) attachments.delete(terminalID);
      }
      if (attachments.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };

  return loop;
}
