import type { GridSize } from "@janela/core";

import type { FrameScheduler } from "./coalesce.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

export interface FakeScheduler extends FrameScheduler {
  fire(): void;
  readonly pendingCount: number;
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

export class FakeRendering implements TerminalRendering {
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
    return this.selection;
  }

  selection: string | undefined;

  readonly pasted: string[] = [];

  paste(text: string): void {
    this.pasted.push(text);
  }

  clearViewport(): void {
    this.cleared += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}
