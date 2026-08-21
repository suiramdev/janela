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
  start(signal: AbortSignal): void;
  /** Frame interval. One frame at 120 Hz; tuned against a benchmark, not argued about. */
  readonly intervalMs: number;
}

export function createFrameLoop(dependencies: {
  readonly terminals: TerminalRegistry;
  readonly deliver: (client: string, terminalID: string, bytes: Uint8Array) => void;
}): FrameLoop {
  void dependencies;
  throw new Error(`not implemented: createFrameLoop`);
}
