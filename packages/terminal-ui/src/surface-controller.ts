/**
 * The glue between a renderer and the client, with no React and no DOM in it.
 *
 * Everything interesting the surface does that is not drawing happens here: the one
 * copy of the output bytes, the coalescing of resize votes, and the callback
 * lifetime. Keeping it out of the component is what makes it testable at all — the
 * component needs a DOM and this needs nothing.
 */

import type { GridSize } from "@janela/core";

import { coalescePerFrame, type FrameScheduler } from "./coalesce.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

export interface SurfaceCallbacks {
  /** Keyboard and paste bytes, forwarded with no interpretation. */
  readonly onInput?: (bytes: Uint8Array) => void;

  /**
   * Coalesced to at most one call per frame, and never called twice with the same
   * size. The parent forwards it as a `resize` request, so a repeat would be a
   * round trip and a `SIGWINCH` that changed nothing.
   */
  readonly onViewportChange?: (size: GridSize) => void;
}

export interface SurfaceController {
  /**
   * Feed repaint bytes from the daemon.
   *
   * **The one copy.** `DaemonConnection.onOutput` hands up a view into the frame
   * being decoded, valid only for the duration of the call, and xterm's `write()`
   * queues its argument to be parsed later. Those two facts are incompatible
   * without a copy, and this is where it happens — once, here, rather than
   * defensively in both places or in neither.
   */
  feed(bytes: Uint8Array): void;

  /**
   * Cancels the pending frame and clears the renderer's callbacks.
   *
   * Does *not* dispose the renderer: the component owns its lifetime, and a
   * controller that disposed it would make the two orderings — controller first or
   * renderer first — mean different things.
   */
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
