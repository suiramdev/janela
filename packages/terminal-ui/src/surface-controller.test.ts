import { describe, expect, test } from "bun:test";

import type { GridSize } from "@janela/core";

import { createSurfaceController } from "./surface-controller.ts";
import { FakeRendering, fakeScheduler } from "./test-fakes.ts";

describe("createSurfaceController", () => {
  test("feed copies: a transient view may be mutated the moment feed returns", () => {
    const rendering = new FakeRendering();
    const controller = createSurfaceController(rendering, {}, fakeScheduler());

    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = buffer.subarray(2, 5);
    controller.feed(view);
    // Exactly what the connection does with the frame buffer after the handler
    // returns, and what xterm's asynchronous write queue would otherwise read.
    buffer.fill(0);

    expect(rendering.fed).toHaveLength(1);
    expect([...(rendering.fed[0] ?? [])]).toEqual([3, 4, 5]);
    expect(rendering.fed[0]).not.toBe(view);
  });

  test("input is passed through untouched", () => {
    const rendering = new FakeRendering();
    const received: Uint8Array[] = [];
    createSurfaceController(
      rendering,
      { onInput: (bytes) => received.push(bytes) },
      fakeScheduler(),
    );

    const typed = new Uint8Array([0x1b, 0x5b, 0x41]);
    rendering.onInput?.(typed);

    expect(received[0]).toBe(typed);
  });

  test("viewport votes coalesce to one per frame, with the last size", () => {
    const rendering = new FakeRendering();
    const scheduler = fakeScheduler();
    const votes: GridSize[] = [];
    createSurfaceController(rendering, { onViewportChange: (size) => votes.push(size) }, scheduler);

    rendering.onViewportChange?.({ columns: 80, rows: 24 });
    rendering.onViewportChange?.({ columns: 90, rows: 24 });
    rendering.onViewportChange?.({ columns: 100, rows: 30 });

    expect(votes).toEqual([]);
    scheduler.fire();

    expect(votes).toEqual([{ columns: 100, rows: 30 }]);
  });

  test("an unchanged size is not voted twice", () => {
    const rendering = new FakeRendering();
    const scheduler = fakeScheduler();
    const votes: GridSize[] = [];
    createSurfaceController(rendering, { onViewportChange: (size) => votes.push(size) }, scheduler);

    rendering.onViewportChange?.({ columns: 80, rows: 24 });
    scheduler.fire();
    rendering.onViewportChange?.({ columns: 80, rows: 24 });
    scheduler.fire();
    rendering.onViewportChange?.({ columns: 80, rows: 25 });
    scheduler.fire();

    expect(votes).toEqual([
      { columns: 80, rows: 24 },
      { columns: 80, rows: 25 },
    ]);
  });

  test("dispose cancels the pending vote and clears the renderer's callbacks", () => {
    const rendering = new FakeRendering();
    const scheduler = fakeScheduler();
    const votes: GridSize[] = [];
    const controller = createSurfaceController(
      rendering,
      { onInput: () => {}, onViewportChange: (size) => votes.push(size) },
      scheduler,
    );

    rendering.onViewportChange?.({ columns: 80, rows: 24 });
    controller.dispose();
    scheduler.fire();

    expect(votes).toEqual([]);
    expect(rendering.onInput).toBeUndefined();
    expect(rendering.onViewportChange).toBeUndefined();
  });

  test("dispose leaves the renderer alive: the component owns it", () => {
    const rendering = new FakeRendering();
    const controller = createSurfaceController(rendering, {}, fakeScheduler());

    controller.dispose();

    expect(rendering.disposed).toBe(false);
  });
});
