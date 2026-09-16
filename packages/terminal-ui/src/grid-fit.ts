import type { GridSize } from "@janela/core";

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export const MINIMUM_GRID: GridSize = { columns: 2, rows: 1 };

function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function gridThatFits(box: PixelSize, cell: PixelSize): GridSize {
  if (!usable(cell.width) || !usable(cell.height)) return MINIMUM_GRID;

  if (!usable(box.width) || !usable(box.height)) return MINIMUM_GRID;

  return {
    columns: Math.max(MINIMUM_GRID.columns, Math.floor(box.width / cell.width)),
    rows: Math.max(MINIMUM_GRID.rows, Math.floor(box.height / cell.height)),
  };
}

export function letterboxMargins(box: PixelSize, cell: PixelSize, grid: GridSize): PixelSize {
  if (!usable(cell.width) || !usable(cell.height)) return { width: 0, height: 0 };

  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return { width: 0, height: 0 };

  return {
    width: Math.max(0, box.width - grid.columns * cell.width),
    height: Math.max(0, box.height - grid.rows * cell.height),
  };
}
