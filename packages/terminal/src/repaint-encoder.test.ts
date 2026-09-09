/**
 * The encoder, tested at the byte level — deliberately.
 *
 * Everywhere else in this package the assertion is "two emulators agree", because
 * pinning bytes pins the encoder's mood. Here the bytes *are* the contract: the
 * difference between `CSI 3 X` `CSI 3 C` and a bare `CSI 3 C` is invisible in a
 * grid comparison against a *fresh* receiver and is exactly the bug that shows up
 * on a real client that already had content there. Each expectation below names
 * the failure it defends.
 */

import { describe, expect, test } from "bun:test";

import { Terminal } from "@xterm/headless";

import {
  RepaintEncoder,
  type LoadedCell,
  type ModeState,
  type RowCells,
} from "./repaint-encoder.ts";

const decoder = new TextDecoder();

function terminal(columns: number, rows: number): Terminal {
  return new Terminal({ cols: columns, rows, allowProposedApi: true, logLevel: "off" });
}

function feed(target: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    target.write(data, resolve);
  });
}

/**
 * A row and a reusable cell, both through the public buffer API.
 *
 * `getCell(x, cell)` loads into the cell it is given, which is what makes one cell
 * per encoder enough; `getCell(0)` with no argument hands back a fresh one to be
 * that cell. The production emulator reaches for the internal `loadCell` instead,
 * which is the same operation without the `undefined` return.
 */
function rowOf(target: Terminal, y: number): { row: RowCells; cell: LoadedCell } {
  const line = target.buffer.active.getLine(target.buffer.active.viewportY + y);
  if (line === undefined) {
    throw new Error(`no line at ${y}`);
  }
  const cell = line.getCell(0);
  if (cell === undefined) {
    throw new Error("no cell at 0");
  }
  return {
    row: {
      length: line.length,
      loadCell: (x, into) => line.getCell(x, into),
    },
    cell: cell as LoadedCell,
  };
}

const DEFAULT_MODES: ModeState = {
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  insert: false,
  origin: false,
  reverseWraparound: false,
  sendFocus: false,
  wraparound: true,
  mouseTracking: "none",
  mouseEncoding: "default",
  cursorVisible: true,
  cursorStyle: 0,
};

function encoded(encoder: RepaintEncoder): string {
  const bytes = encoder.end();
  if (bytes === undefined) {
    throw new Error("the frame overflowed");
  }
  return decoder.decode(bytes);
}

describe("the mode line", () => {
  test("carries both polarities, all four mouse-tracking modes, and the encoding", () => {
    // A delta lands on a client whose modes are whatever its last delta left. A
    // mode line that only ever *sets* — which is what `SerializeAddon` emits — can
    // never turn bracketed paste back off, and that is why a full repaint needs a
    // RIS in front of it and a delta cannot use one.
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 20, rows: 3 });

    encoder.begin(
      {
        ...DEFAULT_MODES,
        applicationCursorKeys: true,
        bracketedPaste: true,
        mouseTracking: "drag",
        mouseEncoding: "sgr",
        cursorVisible: false,
        cursorStyle: 5,
      },
      true,
    );

    expect(encoded(encoder)).toBe(
      "\x1b[0m" +
        "\x1b[?1h\x1b[?66l\x1b[?2004h\x1b[4l\x1b[?6l\x1b[?45l\x1b[?1004l\x1b[?7h" +
        "\x1b[?9;1000;1002;1003l\x1b[?1002h" +
        "\x1b[?1006;1016l\x1b[?1006h" +
        "\x1b[?25l" +
        "\x1b[5 q",
    );
  });

  test("insert and origin mode are neutralised even when the state has them on", async () => {
    // Both change what our own bytes mean: `IRM` makes a row paint shift the rest
    // of the row right, and `DECOM` makes every `CUP` relative to the scroll
    // region. `cursor()` puts them back, after nothing else will be painted.
    const target = terminal(4, 2);
    await feed(target, "ab");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 4, rows: 2 });

    encoder.begin({ ...DEFAULT_MODES, insert: true, origin: true }, false);
    encoder.paintRow(0, row, 4, cell);
    encoder.cursor(2, 0, 4, row, cell);

    expect(encoded(encoder)).toBe(
      ["\x1b[0m\x1b[4l\x1b[?6l", "\x1b[1;1Hab\x1b[K", "\x1b[4h\x1b[?6h", "\x1b[1;3H"].join(""),
    );
  });
});

describe("paintRow", () => {
  test("erases a coloured run rather than stepping over it, and ends the row with EL", async () => {
    // `CSI n C` alone would leave whatever the client had in those cells, and
    // erasing without setting the background first would lose the colour a
    // background-colour erase put there. The trailing `EL` is what makes a short
    // line overwrite a long one.
    const target = terminal(12, 2);
    await feed(target, "ab\x1b[41m\x1b[3X\x1b[3C\x1b[0mc");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 12, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 12, cell);

    expect(encoded(encoder)).toBe(
      ["\x1b[0m", "\x1b[1;1Hab", "\x1b[41m\x1b[3X\x1b[3C", "\x1b[0mc", "\x1b[K"].join(""),
    );
  });

  test("two adjacent runs with different backgrounds are erased separately", async () => {
    const target = terminal(10, 2);
    await feed(target, "\x1b[41m\x1b[2X\x1b[2C\x1b[44m\x1b[2X\x1b[2C\x1b[0mz");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 10, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 10, cell);

    expect(encoded(encoder)).toBe(
      "\x1b[0m" +
        "\x1b[1;1H" +
        "\x1b[41m\x1b[2X\x1b[2C" +
        "\x1b[44m\x1b[2X\x1b[2C" +
        "\x1b[0mz" +
        "\x1b[K",
    );
  });

  test("dim after bold emits 22 and then 2, never 22 alone", async () => {
    // `22` turns off bold *and* dim, so a serialiser that emits it for either one
    // silently drops the other. `SerializeAddon` does exactly that.
    const target = terminal(6, 2);
    await feed(target, "\x1b[1mB\x1b[22;2mD");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 6, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 6, cell);

    expect(encoded(encoder)).toBe(
      ["\x1b[0m", "\x1b[1;1H\x1b[1mB", "\x1b[22;2mD", "\x1b[K"].join(""),
    );
  });

  test("bold after dim emits 22 and then 1", async () => {
    // The other direction, and the one a condition that only checks bold gets
    // wrong: the bold cell is reached with dim tracked, so `1` alone would leave
    // the client's cell both bold and dim.
    const target = terminal(6, 2);
    await feed(target, "\x1b[2mD\x1b[22;1mB");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 6, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 6, cell);

    expect(encoded(encoder)).toBe(
      ["\x1b[0m", "\x1b[1;1H\x1b[2mD", "\x1b[22;1mB", "\x1b[K"].join(""),
    );
  });

  test("a row of untouched cells costs a CUP and an EL, and no colour sequence", async () => {
    // A default cell reports background colour −1 while `CSI 49 m` leaves 0. If
    // the two are compared raw, every blank row pays for a colour it already has.
    const target = terminal(8, 2);
    await feed(target, "x\r\n");
    const { row, cell } = rowOf(target, 1);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 8, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(1, row, 8, cell);

    expect(encoded(encoder)).toBe("\x1b[0m\x1b[2;1H\x1b[K");
  });

  test("a wide character is written once, and its spacer cell is skipped", async () => {
    const target = terminal(8, 2);
    await feed(target, "中文");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 8, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 8, cell);

    expect(encoded(encoder)).toBe("\x1b[0m\x1b[1;1H中文\x1b[K");
  });

  test("a combined character is written from the row's table, not from its codepoint", async () => {
    // The packed cell word holds an *index* for a combined character, and
    // `getCode()` returns the last codepoint of the string — the accent alone.
    const target = terminal(8, 2);
    await feed(target, "e\u0301");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 8, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.paintRow(0, row, 8, cell);

    expect(encoded(encoder)).toBe("\x1b[0m\x1b[1;1He\u0301\x1b[K");
  });
});

describe("cursor", () => {
  test("a cursor past the last column is reproduced by reprinting that column", async () => {
    // The pending-wrap state: `CUP` clamps to `cols`, `CUF` refuses to pass it,
    // and only printing in the last column puts a terminal there.
    const target = terminal(4, 2);
    await feed(target, "abcd");
    expect(target.buffer.active.cursorX).toBe(4);
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 4, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.cursor(4, 0, 4, row, cell);

    expect(encoded(encoder)).toBe("\x1b[0m\x1b[1;4Hd");
  });

  test("pending wrap over an erased last column prints a space and erases it again", async () => {
    // Printing a space would otherwise turn an erased cell into a space cell —
    // identical to look at, different to `getCode()`, and the grid comparison
    // catches it.
    const target = terminal(4, 2);
    await feed(target, "abcd\x1b[1;4H\x1b[41m\x1b[1X\x1b[4C");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 4, rows: 2 });

    encoder.begin(DEFAULT_MODES, false);
    encoder.cursor(4, 0, 4, row, cell);

    expect(encoded(encoder)).toBe("\x1b[0m\x1b[1;4H\x1b[41m \x1b[1X");
  });

  test("under origin mode the row is expressed relative to the scroll region", async () => {
    const target = terminal(6, 10);
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 6, rows: 10 });

    encoder.begin({ ...DEFAULT_MODES, origin: true }, false);
    encoder.cursor(2, 6, 6, row, cell, 4);

    expect(encoded(encoder)).toBe(["\x1b[0m\x1b[?6l", "\x1b[?6h", "\x1b[3;3H"].join(""));
  });
});

describe("the frame buffer", () => {
  test("two frames are views into one allocation", () => {
    // The frame loop copies the view synchronously, so reusing the buffer is the
    // difference between zero allocation per frame per client and one.
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 20, rows: 3 });

    encoder.begin(DEFAULT_MODES, false);
    const first = encoder.end();
    encoder.begin(DEFAULT_MODES, true);
    const second = encoder.end();

    expect(first?.buffer).toBe(second?.buffer);
  });

  test("a frame that does not fit the bound is refused rather than truncated", async () => {
    // The bound is `rows × (cols × MAX_CELL_BYTES + ROW_OVERHEAD_BYTES)` plus a
    // frame's overhead, so a caller that stays within one row paint per row can
    // never reach it. Reaching it means the bound is wrong, and a truncated delta
    // would leave the client's grid quietly incorrect — the caller sends a full
    // repaint instead.
    const target = terminal(2, 1);
    await feed(target, "ab");
    const { row, cell } = rowOf(target, 0);
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 2, rows: 1 });

    encoder.begin(DEFAULT_MODES, false);
    for (let repeat = 0; repeat < 200; repeat += 1) {
      encoder.paintRow(0, row, 2, cell);
    }

    expect(encoder.end()).toBeUndefined();
  });

  test("`wrote` reports content, not the reset prefix", () => {
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 20, rows: 3 });

    encoder.begin(DEFAULT_MODES, false);
    expect(encoder.wrote).toBe(false);

    encoder.scrollUp(1, 3);
    expect(encoder.wrote).toBe(true);
  });
});
