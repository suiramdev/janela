import { describe, expect, test } from "bun:test";

import { Terminal } from "@xterm/headless";

import {
  RepaintEncoder,
  type LoadedCell,
  type ModeState,
  type RowCells,
} from "./repaint-encoder.ts";

interface SourceRow {
  readonly row: RowCells;
  readonly cell: LoadedCell;
}

const decoder = new TextDecoder();

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

function terminal(columns: number, rows: number): Terminal {
  return new Terminal({ cols: columns, rows, allowProposedApi: true, logLevel: "off" });
}

function feed(target: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    target.write(data, resolve);
  });
}

function rowOf(target: Terminal, y: number): SourceRow {
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
      loadCell: (x, into) => {
        line.getCell(x, into);
      },
    },
    cell: cell as LoadedCell,
  };
}

function encoded(encoder: RepaintEncoder): string {
  const bytes = encoder.end();

  if (bytes === undefined) {
    throw new Error("the frame overflowed");
  }

  return decoder.decode(bytes);
}

describe("the mode line", () => {
  test("carries both polarities, so a mode a past delta set can be turned back off", () => {
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

  test("insert and origin mode are neutralised for the frame and restored by cursor()", async () => {
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

  test("bold after dim emits 22 and then 1, so the client is not left both", async () => {
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
    const encoder = new RepaintEncoder();
    encoder.reserve({ columns: 20, rows: 3 });

    encoder.begin(DEFAULT_MODES, false);

    const first = encoder.end();

    encoder.begin(DEFAULT_MODES, true);

    const second = encoder.end();

    expect(first?.buffer).toBe(second?.buffer);
  });

  test("a frame that does not fit the bound is refused rather than truncated", async () => {
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
