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
 * See docs/performance.md § Terminal throughput.
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

/**
 * A ring buffer, one parked consumer, and a FIFO of blocked producers.
 *
 * Single consumer by construction: `next()` parks exactly one resolver, and a
 * second concurrent `next()` is a caller bug rather than a queue that quietly
 * interleaves two `for await` loops over one stream.
 *
 * After `finish()` a `push` resolves and discards the item. The consumer is gone
 * — a producer that awaited forever there would be a leak, and one that threw
 * would make "the client disconnected" an error path in every caller.
 *
 * @throws {RangeError} when `capacity` is not a positive integer. A zero-capacity
 * queue is not a bound, it is a queue that drops everything.
 */
export function boundedQueue<T>(options: BoundedQueueOptions): BoundedQueue<T> {
  const { capacity, onOverflow, onDrop } = options;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("capacity must be a positive integer");
  }

  /** The ring. `undefined` marks a free slot, which is why items are taken out. */
  const slots: (T | undefined)[] = Array.from<T | undefined>({ length: capacity });
  let head = 0;
  let size = 0;
  let finished = false;

  /** Producers waiting for a slot, oldest first. Only ever used by `block`. */
  const blocked: { readonly item: T; readonly resolve: () => void }[] = [];
  /** The consumer's parked `next`, when it is waiting on an empty queue. */
  let waiting: ((result: IteratorResult<T>) => void) | undefined;

  /**
   * Empties the slot at `index`.
   *
   * The cast is `noUncheckedIndexedAccess`, not optimism: the caller has already
   * established `size > 0`, so the slot holds an item.
   */
  const take = (index: number): T => {
    const value = slots[index] as T;
    slots[index] = undefined;
    return value;
  };

  /** Hands the item straight to a parked consumer, or stores it. */
  const enqueue = (item: T): void => {
    const consumer = waiting;
    if (consumer !== undefined) {
      // A parked consumer implies an empty ring, so there is nothing to order
      // this item behind.
      waiting = undefined;
      consumer({ value: item, done: false });
      return;
    }
    slots[(head + size) % capacity] = item;
    size += 1;
  };

  const iterator: AsyncIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      if (size > 0) {
        const value = take(head);
        head = (head + 1) % capacity;
        size -= 1;
        // The slot that just freed goes to the oldest blocked producer, in the
        // same step, so `block` never leaves capacity unused.
        const producer = blocked.shift();
        if (producer !== undefined) {
          slots[(head + size) % capacity] = producer.item;
          size += 1;
          producer.resolve();
        }
        return Promise.resolve({ value, done: false });
      }
      if (finished) {
        return Promise.resolve({ value: undefined, done: true });
      }
      if (waiting !== undefined) {
        throw new Error("boundedQueue has one consumer");
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        waiting = resolve;
      });
    },

    return(): Promise<IteratorResult<T>> {
      // A consumer breaking out of `for await` must not leave producers blocked
      // on a queue nobody will drain again.
      queue.finish();
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const queue: BoundedQueue<T> = {
    get capacity(): number {
      return capacity;
    },
    get size(): number {
      return size;
    },

    push(item: T): Promise<void> {
      if (finished) {
        return Promise.resolve();
      }
      if (size < capacity) {
        enqueue(item);
        return Promise.resolve();
      }
      if (onOverflow === "dropOldest") {
        take(head);
        head = (head + 1) % capacity;
        size -= 1;
        onDrop?.(1);
        enqueue(item);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        blocked.push({ item, resolve });
      });
    },

    finish(): void {
      if (finished) return;
      finished = true;
      // Blocked producers are released rather than rejected: the item is lost
      // because the consumer is gone, which is not the producer's error.
      for (const producer of blocked.splice(0)) {
        producer.resolve();
      }
      const consumer = waiting;
      if (consumer !== undefined) {
        waiting = undefined;
        consumer({ value: undefined, done: true });
      }
    },

    [Symbol.asyncIterator](): AsyncIterator<T> {
      return iterator;
    },
  };

  return queue;
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
