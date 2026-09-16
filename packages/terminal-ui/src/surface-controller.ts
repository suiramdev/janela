import type { GridSize } from "@janela/core";

import { coalescePerFrame, type FrameScheduler } from "./coalesce.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

export interface SurfaceCallbacks {
  readonly onInput?: (bytes: Uint8Array) => void;

  readonly onViewportChange?: (size: GridSize) => void;
}

export interface SurfaceController {
  feed(bytes: Uint8Array): void;

  dispose(): void;
}

export function createSurfaceController(
  rendering: TerminalRendering,
  callbacks: SurfaceCallbacks,
  scheduler: FrameScheduler,
): SurfaceController {
  let lastDelivered: GridSize | undefined;

  const votes = coalescePerFrame<GridSize>((size) => {
    if (lastDelivered?.columns === size.columns && lastDelivered.rows === size.rows) return;

    lastDelivered = size;
    callbacks.onViewportChange?.(size);
  }, scheduler);

  rendering.onInput = callbacks.onInput;
  rendering.onViewportChange = (size) => {
    votes.push(size);
  };

  return {
    feed(bytes: Uint8Array): void {
      rendering.feed(bytes.slice());
    },
    dispose(): void {
      votes.cancel();
      rendering.onInput = undefined;
      rendering.onViewportChange = undefined;
    },
  };
}
