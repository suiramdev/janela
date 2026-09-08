import { describe, expect, test } from "bun:test";

import { coalescePerFrame } from "./coalesce.ts";
import { fakeScheduler } from "./test-fakes.ts";

describe("coalescePerFrame", () => {
  test("many pushes in one frame deliver once, with the last value", () => {
    const scheduler = fakeScheduler();
    const delivered: number[] = [];
    const coalescer = coalescePerFrame<number>((value) => delivered.push(value), scheduler);

    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);

    expect(delivered).toEqual([]);
    expect(scheduler.pendingCount).toBe(1);

    scheduler.fire();

    expect(delivered).toEqual([3]);
  });

  test("a push after the frame fires schedules another frame", () => {
    const scheduler = fakeScheduler();
    const delivered: number[] = [];
    const coalescer = coalescePerFrame<number>((value) => delivered.push(value), scheduler);

    coalescer.push(1);
    scheduler.fire();
    coalescer.push(2);

    expect(scheduler.pendingCount).toBe(1);
    scheduler.fire();

    expect(delivered).toEqual([1, 2]);
  });

  test("a frame with nothing pushed delivers nothing", () => {
    const scheduler = fakeScheduler();
    const delivered: number[] = [];
    coalescePerFrame<number>((value) => delivered.push(value), scheduler);

    scheduler.fire();

    expect(delivered).toEqual([]);
  });

  test("equal consecutive values are both delivered: deduping is the caller's job", () => {
    const scheduler = fakeScheduler();
    const delivered: string[] = [];
    const coalescer = coalescePerFrame<string>((value) => delivered.push(value), scheduler);

    coalescer.push("same");
    scheduler.fire();
    coalescer.push("same");
    scheduler.fire();

    expect(delivered).toEqual(["same", "same"]);
  });

  test("cancel drops the pending value and the scheduled frame", () => {
    const scheduler = fakeScheduler();
    const delivered: number[] = [];
    const coalescer = coalescePerFrame<number>((value) => delivered.push(value), scheduler);

    coalescer.push(1);
    coalescer.cancel();

    expect(scheduler.cancelledCount).toBe(1);
    expect(scheduler.pendingCount).toBe(0);

    scheduler.fire();

    expect(delivered).toEqual([]);
  });

  test("a push after cancel still works", () => {
    const scheduler = fakeScheduler();
    const delivered: number[] = [];
    const coalescer = coalescePerFrame<number>((value) => delivered.push(value), scheduler);

    coalescer.push(1);
    coalescer.cancel();
    coalescer.push(2);
    scheduler.fire();

    expect(delivered).toEqual([2]);
  });

  test("undefined is a value, not a sentinel", () => {
    const scheduler = fakeScheduler();
    let calls = 0;
    const coalescer = coalescePerFrame<number | undefined>(() => {
      calls += 1;
    }, scheduler);

    coalescer.push(undefined);
    scheduler.fire();

    expect(calls).toBe(1);
  });
});
