import type { TerminalID } from "@janela/core";
import type { Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";

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
 * Four rules, all of them load-bearing:
 *
 * 1. **One drain per terminal per frame, N encodes.** `drain()` is the feed and
 *    `repaintFor()` is encode-only (`@janela/terminal`, #21); draining per
 *    attached client would multiply the work by the number of windows.
 * 2. **Every live terminal is drained, watched or not.** A terminal nobody has
 *    open still has to consume, or its child blocks in `write(2)` at the PTY's
 *    high-water mark and "your terminals survive the window closing" stops being
 *    true. It is also where an exit and a lost descriptor are observed.
 * 3. **A slow client applies back-pressure to its own stream and nothing else.** A
 *    phone on a bad connection must not slow down the Mac's window.
 * 4. **Nothing here is per-byte.** The frame loop touches counters and buffer
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
  /**
   * Something may have become live: arm the interval if it is not running.
   *
   * The loop drops its timer when there is nothing to drain and nobody attached,
   * so whoever can start a terminal has to say so. A missed wake costs the
   * terminal nothing until the next request or state change; a missed *drain*
   * would cost its child a blocked write, which is why the loop errs towards one
   * extra empty frame rather than one fewer.
   */
  wake(): void;
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
   * Every terminal the daemon holds, for the per-frame drain.
   *
   * Separate from `terminals` because `TerminalRegistry` cannot enumerate itself:
   * it answers `get`, `inSession` and `liveCount`, and the loop needs "all of
   * them" including the ones nobody is watching. Pass a registry iterator here
   * the day it grows one.
   */
  readonly liveTerminals: () => Iterable<LiveTerminal>;
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
  const { terminals, liveTerminals, hasRoom, deliver, log } = dependencies;

  /** Terminal → its attached clients. */
  const attachments = new Map<TerminalID, Map<string, Attachment>>();
  /** Fed this frame, so a terminal that is both live and watched drains once. */
  const drained = new Set<TerminalID>();
  /** Terminals whose last `drain()` threw, so the warning is logged once. */
  const failing = new Set<TerminalID>();
  let timer: Timer | undefined;
  /** Whether `start` has been called and its signal has not aborted. */
  let armed = false;

  /**
   * The feed, at most once per terminal per frame.
   *
   * `drain()` throws when the descriptor is lost — `PseudoTerminalFailure` with
   * `detail.kind === "readFailed"` (#17). That is one terminal's problem: letting
   * it escape would end the frame for every other terminal and, from a timer
   * callback, take the loop with it. Its clients are re-owed a full repaint, so a
   * terminal that comes back (a `restart` re-establishes the descriptor) resumes
   * with a whole screen rather than a delta against one nobody has.
   */
  const feed = (terminal: LiveTerminal): boolean => {
    if (drained.has(terminal.id)) return !failing.has(terminal.id);
    drained.add(terminal.id);
    try {
      terminal.drain();
      failing.delete(terminal.id);
      return true;
    } catch (error) {
      if (!failing.has(terminal.id)) {
        failing.add(terminal.id);
        log.warning("drain failed", {
          terminalID: terminal.id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      for (const attachment of attachments.get(terminal.id)?.values() ?? []) {
        attachment.full = true;
      }
      return false;
    }
  };

  const loop: FrameLoop = {
    intervalMs: FRAME_INTERVAL_MS,

    start(signal: AbortSignal): void {
      armed = true;
      // Armed unconditionally: the loop cannot know whether a terminal is live
      // without asking, and the first frame costs one empty pass before `tick`
      // drops the timer again.
      if (timer === undefined) {
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
      drained.clear();
      let live = 0;

      // The feed. Every live terminal, watched or not — a detached terminal that
      // stops consuming blocks its child at the PTY's high-water mark.
      for (const terminal of liveTerminals()) {
        const kind = terminal.state.kind;
        // One small state object per live terminal per frame is what asking this
        // through `LiveTerminal` costs; nothing else in the frame allocates.
        if (kind !== "running" && kind !== "needsAttention") continue;
        live += 1;
        feed(terminal);
      }

      for (const [terminalID, clients] of attachments) {
        const terminal = terminals.get(terminalID);
        if (terminal === undefined) {
          // Gone from the registry: the session layer owns that transition and
          // has already told the clients. Deleting during iteration is defined.
          attachments.delete(terminalID);
          continue;
        }

        // A watched terminal the enumeration did not yield is still fed, and
        // still exactly once: its client's screen would otherwise never move.
        if (!feed(terminal)) continue;

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

      // Nothing to feed and nobody watching: stop waking up. `attach` and `wake`
      // arm it again.
      if (live === 0 && attachments.size === 0 && timer !== undefined) {
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
      // The timer stays: a terminal nobody watches still has to be drained, and
      // `tick` is what decides there is nothing left to do.
    },

    detachAll(client: string): void {
      for (const [terminalID, clients] of attachments) {
        clients.delete(client);
        if (clients.size === 0) attachments.delete(terminalID);
      }
    },

    wake(): void {
      if (armed && timer === undefined) {
        timer = setInterval(loop.tick, FRAME_INTERVAL_MS);
      }
    },
  };

  return loop;
}
