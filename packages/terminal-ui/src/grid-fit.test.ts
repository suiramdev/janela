import { describe, expect, test } from "bun:test";

import { MINIMUM_GRID, gridThatFits, letterboxMargins } from "./grid-fit.ts";

describe("gridThatFits", () => {
  test("floors: a partial cell is not a cell", () => {
    // Deliberately past the half-cell mark in both axes: rounding would claim a
    // column and a row that are only partly on screen.
    expect(gridThatFits({ width: 813, height: 409 }, { width: 8, height: 16 })).toEqual({
      columns: 101,
      rows: 25,
    });
  });

  test("an exact fit keeps every cell", () => {
    expect(gridThatFits({ width: 800, height: 400 }, { width: 8, height: 16 })).toEqual({
      columns: 100,
      rows: 25,
    });
  });

  test("clamps to the minimum xterm will hold", () => {
    expect(gridThatFits({ width: 4, height: 4 }, { width: 8, height: 16 })).toEqual(MINIMUM_GRID);
  });

  test("a degenerate cell measurement yields the minimum, not an infinity", () => {
    expect(gridThatFits({ width: 800, height: 400 }, { width: 0, height: 16 })).toEqual(
      MINIMUM_GRID,
    );
    expect(gridThatFits({ width: 800, height: 400 }, { width: 8, height: Number.NaN })).toEqual(
      MINIMUM_GRID,
    );
    expect(gridThatFits({ width: 800, height: 400 }, { width: -8, height: 16 })).toEqual(
      MINIMUM_GRID,
    );
  });

  test("a collapsed box yields the minimum", () => {
    expect(gridThatFits({ width: 0, height: 0 }, { width: 8, height: 16 })).toEqual(MINIMUM_GRID);
  });
});

describe("letterboxMargins", () => {
  test("an exact fit leaves nothing over", () => {
    expect(
      letterboxMargins(
        { width: 800, height: 400 },
        { width: 8, height: 16 },
        {
          columns: 100,
          rows: 25,
        },
      ),
    ).toEqual({ width: 0, height: 0 });
  });

  test("rounding leaves the remainder", () => {
    expect(
      letterboxMargins(
        { width: 809, height: 407 },
        { width: 8, height: 16 },
        {
          columns: 101,
          rows: 25,
        },
      ),
    ).toEqual({ width: 1, height: 7 });
  });

  test("a grid smaller than the box letterboxes the difference", () => {
    // Another client is attached and smaller, so the daemon sized the PTY down.
    expect(
      letterboxMargins(
        { width: 800, height: 400 },
        { width: 8, height: 16 },
        {
          columns: 60,
          rows: 10,
        },
      ),
    ).toEqual({ width: 320, height: 240 });
  });

  test("a grid larger than the box never reports a negative margin", () => {
    expect(
      letterboxMargins(
        { width: 100, height: 100 },
        { width: 8, height: 16 },
        {
          columns: 100,
          rows: 25,
        },
      ),
    ).toEqual({ width: 0, height: 0 });
  });

  test("a degenerate cell measurement reports no margin", () => {
    expect(
      letterboxMargins(
        { width: 800, height: 400 },
        { width: 0, height: 0 },
        {
          columns: 100,
          rows: 25,
        },
      ),
    ).toEqual({ width: 0, height: 0 });
  });
});
