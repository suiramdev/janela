export type OverflowPolicy = "block" | "dropOldest";

export interface BoundedQueueOptions {
  readonly capacity: number;
  readonly onOverflow: OverflowPolicy;
  readonly onDrop?: (dropped: number) => void;
}

export interface BoundedQueue<T> extends AsyncIterable<T> {
  readonly capacity: number;
  readonly size: number;
  push(item: T): Promise<void>;
  finish(): void;
}

export interface WaterMarks {
  readonly highWater: number;
  readonly lowWater: number;
}

export const TERMINAL_WATER_MARKS: WaterMarks = {
  highWater: 4 * 1024 * 1024,
  lowWater: 1024 * 1024,
};

export function boundedQueue<T>(options: BoundedQueueOptions): BoundedQueue<T> {
  const { capacity, onOverflow, onDrop } = options;

  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("capacity must be a positive integer");
  }

  const slots: (T | undefined)[] = Array.from<T | undefined>({ length: capacity });
  let head = 0;
  let size = 0;
  let finished = false;

  const blocked: { readonly item: T; readonly resolve: () => void }[] = [];
  let waiting: ((result: IteratorResult<T>) => void) | undefined;

  const take = (index: number): T => {
    // SAFETY: every caller narrows `size > 0` before calling, so the slot at `index` holds an item; the assertion answers `noUncheckedIndexedAccess`, not a guess.
    const value = slots[index] as T;

    slots[index] = undefined;

    return value;
  };

  const enqueue = (item: T): void => {
    const consumer = waiting;

    if (consumer !== undefined) {
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
