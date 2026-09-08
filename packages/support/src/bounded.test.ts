import { describe, expect, test } from "bun:test";

import { boundedQueue } from "./bounded.ts";

/** Takes `count` items, which is what a consumer's `for await` does one at a time. */
async function drain<T>(queue: AsyncIterable<T>, count: number): Promise<T[]> {
  const taken: T[] = [];
  for await (const item of queue) {
    taken.push(item);
    if (taken.length === count) break;
  }
  return taken;
}

/**
 * Whether a promise has settled, without awaiting it.
 *
 * Microtask flushes rather than a timer: every resolution in this queue happens
 * synchronously inside `push`, `next` or `finish`, so two drains of the
 * microtask queue are enough and nothing here depends on the wall clock.
 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe("boundedQueue with dropOldest", () => {
  test("at capacity the oldest is discarded and the drop is reported", async () => {
    const drops: number[] = [];
    const queue = boundedQueue<number>({
      capacity: 2,
      onOverflow: "dropOldest",
      onDrop: (dropped) => drops.push(dropped),
    });

    await queue.push(1);
    await queue.push(2);
    expect(queue.size).toBe(2);
    await queue.push(3);
    await queue.push(4);

    expect(drops).toEqual([1, 1]);
    expect(queue.size).toBe(2);
    expect(await drain(queue, 2)).toEqual([3, 4]);
  });

  test("a push never waits, however far behind the consumer is", async () => {
    const queue = boundedQueue<number>({ capacity: 1, onOverflow: "dropOldest" });

    for (let index = 0; index < 100; index += 1) {
      // Sequential on purpose: the claim is that *each* push settles while the
      // consumer is still behind, which a batched `Promise.all` would hide.
      // oxlint-disable-next-line no-await-in-loop
      expect(await settled(queue.push(index))).toBe(true);
    }

    expect(queue.size).toBe(1);
    expect(await drain(queue, 1)).toEqual([99]);
  });
});

describe("boundedQueue with block", () => {
  test("a push at capacity waits for a take, then delivers in order", async () => {
    const queue = boundedQueue<string>({ capacity: 1, onOverflow: "block" });

    await queue.push("first");
    const blocked = queue.push("second");
    expect(await settled(blocked)).toBe(false);
    expect(queue.size).toBe(1);

    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("first");

    expect(await settled(blocked)).toBe(true);
    expect((await iterator.next()).value).toBe("second");
  });

  test("blocked producers are released in the order they arrived", async () => {
    const queue = boundedQueue<number>({ capacity: 1, onOverflow: "block" });
    const resolved: number[] = [];

    await queue.push(0);
    for (const item of [1, 2, 3]) {
      void queue.push(item).then(() => resolved.push(item));
    }

    expect(await drain(queue, 4)).toEqual([0, 1, 2, 3]);
    expect(resolved).toEqual([1, 2, 3]);
  });
});

describe("boundedQueue lifecycle", () => {
  test("finish drains what is queued and then ends the sequence", async () => {
    const queue = boundedQueue<number>({ capacity: 4, onOverflow: "block" });

    await queue.push(1);
    await queue.push(2);
    queue.finish();

    const taken: number[] = [];
    for await (const item of queue) taken.push(item);
    expect(taken).toEqual([1, 2]);
  });

  test("finish wakes a consumer parked on an empty queue", async () => {
    const queue = boundedQueue<number>({ capacity: 4, onOverflow: "block" });
    const iterator = queue[Symbol.asyncIterator]();
    const parked = iterator.next();

    queue.finish();

    expect((await parked).done).toBe(true);
  });

  test("finish releases a blocked producer rather than leaving it waiting", async () => {
    const queue = boundedQueue<number>({ capacity: 1, onOverflow: "block" });
    await queue.push(1);
    const blocked = queue.push(2);

    queue.finish();

    expect(await settled(blocked)).toBe(true);
  });

  test("a push after finish resolves and delivers nothing", async () => {
    const queue = boundedQueue<number>({ capacity: 2, onOverflow: "block" });
    queue.finish();

    expect(await settled(queue.push(1))).toBe(true);
    expect(queue.size).toBe(0);

    const taken: number[] = [];
    for await (const item of queue) taken.push(item);
    expect(taken).toEqual([]);
  });

  test("breaking out of a for await finishes the queue and frees its producers", async () => {
    const queue = boundedQueue<number>({ capacity: 1, onOverflow: "block" });
    await queue.push(1);
    const blocked = queue.push(2);

    for await (const item of queue) {
      expect(item).toBe(1);
      break;
    }

    expect(await settled(blocked)).toBe(true);
    expect(await settled(queue.push(3))).toBe(true);
  });

  test("two concurrent consumers are a caller bug, not an interleaving", async () => {
    const queue = boundedQueue<number>({ capacity: 2, onOverflow: "block" });
    const iterator = queue[Symbol.asyncIterator]();
    void iterator.next();

    expect(() => iterator.next()).toThrow("one consumer");
  });

  test("a capacity that is not a positive integer is refused", () => {
    expect(() => boundedQueue<number>({ capacity: 0, onOverflow: "block" })).toThrow(RangeError);
    expect(() => boundedQueue<number>({ capacity: -1, onOverflow: "dropOldest" })).toThrow(
      RangeError,
    );
    expect(() => boundedQueue<number>({ capacity: 1.5, onOverflow: "block" })).toThrow(RangeError);
  });
});
