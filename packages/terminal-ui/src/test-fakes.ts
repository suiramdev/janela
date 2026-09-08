/**
 * Fakes for this package's tests. Deliberately not exported from `index.ts`.
 *
 * The frame clock is faked because coalescing is a claim about *when* something is
 * delivered, and a real `requestAnimationFrame` turns that claim into a race. The
 * renderer is faked because what this package's logic does to a renderer — copy
 * before feeding, dedupe before voting, clear the callbacks on dispose — is exactly
 * what a real xterm would hide.
 */

import type { GridSize } from "@janela/core";

import type { FrameScheduler } from "./coalesce.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

export interface FakeScheduler extends FrameScheduler {
  /** Runs every callback scheduled so far, as one frame. */
  fire(): void;
  /** How many callbacks are waiting for a frame. */
  readonly pendingCount: number;
  /** How many scheduled callbacks were cancelled before they ran. */
  readonly cancelledCount: number;
}

export function fakeScheduler(): FakeScheduler {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  let cancelled = 0;
  return {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      if (callbacks.delete(handle)) cancelled += 1;
    },
    fire() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback();
    },
    get pendingCount() {
      return callbacks.size;
    },
    get cancelledCount() {
      return cancelled;
    },
  };
}

/** A `TerminalRendering` that records what it was told, and nothing else. */
export class FakeRendering implements TerminalRendering {
  /** Every chunk handed to `feed`, by reference — identity is under test. */
  readonly fed: Uint8Array[] = [];
  viewport: GridSize = { columns: 80, rows: 24 };
  onViewportChange: ((size: GridSize) => void) | undefined;
  onInput: ((bytes: Uint8Array) => void) | undefined;
  disposed = false;
  cleared = 0;

  feed(bytes: Uint8Array): void {
    this.fed.push(bytes);
  }

  selectedText(): string | undefined {
    return undefined;
  }

  clearViewport(): void {
    this.cleared += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}
