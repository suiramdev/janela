import type { DockEdge } from "@janela/core";

export interface DropBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const TERMINAL_DRAG_TYPE = "application/x-janela-terminal";

export function dockEdge(
  pointer: { readonly x: number; readonly y: number },
  bounds: DropBounds,
): DockEdge {
  if (bounds.width <= 0 || bounds.height <= 0) return "left";

  const px = (pointer.x - bounds.left) / bounds.width;
  const py = (pointer.y - bounds.top) / bounds.height;

  let edge: DockEdge = "left";
  let nearest = px;

  if (1 - px < nearest) {
    edge = "right";
    nearest = 1 - px;
  }

  if (py < nearest) {
    edge = "top";
    nearest = py;
  }

  if (1 - py < nearest) edge = "bottom";

  return edge;
}
