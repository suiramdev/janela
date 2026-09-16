import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";

import { createDirectoryPickerQueue } from "./directory-picker.ts";

describe("createDirectoryPickerQueue", () => {
  test("a request waits on screen, and the chosen folder resolves it", async () => {
    const queue = createDirectoryPickerQueue();
    const picked = queue.pickDirectory({ title: "Add Project" });

    expect(queue.pending).toEqual({ title: "Add Project" });

    queue.answer(absolutePath("/Users/ada/code"));

    expect(await picked).toBe(absolutePath("/Users/ada/code"));
    expect(queue.pending).toBeUndefined();
  });

  test("cancelling resolves with nothing and leaves nothing on screen", async () => {
    const queue = createDirectoryPickerQueue();
    const picked = queue.pickDirectory({ title: "Open Folder" });

    queue.answer(undefined);

    expect(await picked).toBeUndefined();
    expect(queue.pending).toBeUndefined();
  });

  test("a second request while one is on screen is refused, not queued", async () => {
    const queue = createDirectoryPickerQueue();
    const first = queue.pickDirectory({ title: "Open Folder" });

    expect(await queue.pickDirectory({ title: "Add Project" })).toBeUndefined();
    expect(queue.pending).toEqual({ title: "Open Folder" });

    queue.answer(absolutePath("/tmp"));

    expect(await first).toBe(absolutePath("/tmp"));
  });

  test("notifies when a request appears and when it is answered, and never otherwise", () => {
    const queue = createDirectoryPickerQueue();
    let notified = 0;
    const stop = queue.subscribe(() => {
      notified += 1;
    });

    queue.answer(undefined);

    expect(notified).toBe(0);

    void queue.pickDirectory({ title: "Open Folder" });

    expect(notified).toBe(1);

    queue.answer(undefined);

    expect(notified).toBe(2);

    stop();
    void queue.pickDirectory({ title: "Open Folder" });

    expect(notified).toBe(2);
  });
});
