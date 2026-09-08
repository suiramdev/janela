/**
 * Pixels to cells, and the pixels left over.
 *
 * A terminal grid is whole cells or it is a lie: half a column is a column the
 * program running in it will write into and the user cannot read. So the box is
 * divided, floored, and the remainder is left visible as a letterbox — never
 * scaled, because scaling a monospace grid is how text stops being crisp.
 */

import type { GridSize } from "@janela/core";

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest grid that can be reported.
 *
 * xterm clamps a `resize` to 2×1 and then holds that, so proposing anything smaller
 * would make the vote and the held grid disagree — the same rule the daemon-side
 * emulator follows in `packages/terminal/src/headless-emulator.ts`, where the
 * comment explains what a disagreement costs.
 */
export const MINIMUM_GRID: GridSize = { columns: 2, rows: 1 };

function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The largest whole-cell grid that fits in `box`.
 *
 * A degenerate cell size — zero, negative or non-finite, which is what a
 * measurement taken before the font loads looks like — yields the minimum rather
 * than an infinity, because the caller's next move is to send this to the daemon.
 */
export function gridThatFits(box: PixelSize, cell: PixelSize): GridSize {
  if (!usable(cell.width) || !usable(cell.height)) return MINIMUM_GRID;
  if (!usable(box.width) || !usable(box.height)) return MINIMUM_GRID;
  return {
    columns: Math.max(MINIMUM_GRID.columns, Math.floor(box.width / cell.width)),
    rows: Math.max(MINIMUM_GRID.rows, Math.floor(box.height / cell.height)),
  };
}

/**
 * The pixels `box` has that `grid` does not use.
 *
 * Non-zero in two situations, and both are normal: rounding, because a box is
 * rarely a whole number of cells; and a grid smaller than this surface could show,
 * because the daemon sizes the PTY to the *smallest* attached viewport and another
 * client may be smaller than us. Never negative — a grid larger than the box
 * overflows and is clipped, which is the honest rendering of "somebody else is
 * smaller than you".
 */
export function letterboxMargins(box: PixelSize, cell: PixelSize, grid: GridSize): PixelSize {
  if (!usable(cell.width) || !usable(cell.height)) return { width: 0, height: 0 };
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return { width: 0, height: 0 };
  return {
    width: Math.max(0, box.width - grid.columns * cell.width),
    height: Math.max(0, box.height - grid.rows * cell.height),
  };
}
