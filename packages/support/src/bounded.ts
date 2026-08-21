/**
 * Bounded buffers, because non-negotiable #9 says every accumulator needs a
 * documented bound and terminal output is effectively infinite.
 *
 * There are exactly four places in Janela that accumulate: the PTY read buffer
 * (bounded in `@janela/pty`, in Rust, by high/low water marks), the emulator's
 * scrollback (bounded by `@xterm/headless`), a per-client output queue, and the
 * frame length a socket reader will accept (bounded in `@janela/protocol`).
 * Two of those four use what is here.
 */

/**
 * A queue with a ceiling, and an explicit answer for what happens at the
 * ceiling.
 *
 * The two policies are not interchangeable and the choice is a correctness
 * decision, not a tuning one:
 *
 * - `block` — the producer waits. Correct for terminal *input*: dropping a
 *   keystroke is data loss the user can see.
 * - `dropOldest` — the oldest entry is discarded. Correct only for *coalesced
 *   repaints*, where a newer frame supersedes an older one and the next full
 *   repaint recovers anything lost. Never correct for raw byte streams: a
 *   dropped byte truncates an escape sequence and desynchronises the parser
 *   until the next full repaint, which is not a recovery, it is a corruption
 *   with a delay.
 *
 * See docs/performance.md § Terminal throughput and
 * docs/decisions/0016-daemon-protocol.md.
 */
export type OverflowPolicy = "block" | "dropOldest";

export interface BoundedQueueOptions {
  /** Hard ceiling. Reaching it is a normal condition, not an error. */
  readonly capacity: number;
  readonly onOverflow: OverflowPolicy;
  /** Called when `dropOldest` discards, so a queue that sheds says so in a log. */
  readonly onDrop?: (dropped: number) => void;
}

export interface BoundedQueue<T> extends AsyncIterable<T> {
  readonly capacity: number;
  readonly size: number;
  /** Resolves once the item is queued. With `block`, that may be later. */
  push(item: T): Promise<void>;
  /** Finishes the sequence. Consumers see a clean end, not an error. */
  finish(): void;
}

export function boundedQueue<T>(options: BoundedQueueOptions): BoundedQueue<T> {
  void options;
  throw new Error(`not implemented: boundedQueue`);
}

/**
 * A byte ring with a high and a low water mark.
 *
 * The mechanism that makes back-pressure work without dropping anything: past
 * `highWater` the producer stops being asked for more, and it is asked again
 * only once the backlog drains to `lowWater`. Two marks rather than one, because
 * a single mark makes the producer stutter at the boundary.
 */
export interface WaterMarks {
  readonly highWater: number;
  readonly lowWater: number;
}

/** The marks the PTY layer uses. Measured, not guessed — see docs/performance.md. */
export const TERMINAL_WATER_MARKS: WaterMarks = {
  // 4 MB is roughly a second of a `yes` flood at the rate the native reader
  // sustains, which is long enough that a normal frame never touches the mark and
  // short enough that a stalled consumer costs bounded memory. Measured: with the
  // consumer stopped entirely, resident memory grew by ~4 MB and then stopped.
  highWater: 4 * 1024 * 1024,
  // A quarter of the high mark, so the producer resumes in long runs rather than
  // stuttering at the boundary.
  lowWater: 1024 * 1024,
};
