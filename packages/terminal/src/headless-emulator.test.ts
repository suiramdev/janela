/**
 * The emulator, tested the way docs/testing.md says to: **two emulators**.
 *
 * Feed bytes to one, encode a repaint, feed the result to a second, and assert
 * the two grids are identical — cell by cell, attributes included, plus the
 * cursor and which buffer is active. That is the only assertion that means
 * "reattaching is correct rather than lucky"; comparing byte strings would pin
 * the encoder's mood instead.
 *
 * The receiver is a raw `@xterm/headless` terminal, not another `HeadlessEmulator`,
 * because a client renders with a stock emulator and that is the thing that has to
 * agree with us.
 */

import { describe, expect, test } from "bun:test";

import { Terminal } from "@xterm/headless";

import { createEmulator, HeadlessEmulator, SCROLL_RING } from "./headless-emulator.ts";
import {
  DEFAULT_SCROLLBACK,
  MAX_OSC_TEXT_LENGTH,
  type PromptMark,
  type TerminalEventSink,
  type TerminalNotification,
} from "./terminal-emulating.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function emulator(columns: number, rows: number, scrollback = 100): HeadlessEmulator {
  return new HeadlessEmulator({ columns, rows }, scrollback);
}

/** Feeds a string through the production path. */
function feed(target: HeadlessEmulator, data: string): void {
  target.feed(encoder.encode(data));
}

/**
 * A stock receiver, as a client would run one — including the one thing a client
 * has to supply itself.
 *
 * `windowOptions.setWinSizeChars` is the gate the library checks before any
 * handler sees `CSI 8 t`, and it implements no case for parameter 8 behind it, so
 * the resize is the client's. This mirrors `xtermRendering` in
 * `packages/terminal-ui`, which is the real thing; keep the two in step.
 */
function receiver(columns: number, rows: number): Terminal {
  const target = new Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    logLevel: "off",
    windowOptions: { setWinSizeChars: true },
  });
  target.parser.registerCsiHandler({ final: "t" }, (parameters) => {
    if (parameters[0] !== 8) return false;
    const announcedRows = parameters[1];
    const announcedColumns = parameters[2];
    if (typeof announcedRows !== "number" || typeof announcedColumns !== "number") return true;
    target.resize(announcedColumns, announcedRows);
    return true;
  });
  return target;
}

function replay(target: Terminal, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    target.write(bytes, resolve);
  });
}

/**
 * Every cell's character and attributes, plus the cursor and the active buffer.
 *
 * Ported from `spikes/emulator-xterm/round-trip.ts`, which is what established
 * that the serialise-and-replay approach holds for an alternate-screen TUI.
 */
function dumpGrid(target: Terminal): string {
  const buffer = target.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < target.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (line === undefined) {
      out.push("");
      continue;
    }
    let row = "";
    for (let x = 0; x < target.cols; x += 1) {
      const cell = line.getCell(x);
      if (cell === undefined) {
        continue;
      }
      row += `${cell.getChars() || " "}|${cell.getFgColor()}/${cell.getBgColor()}/${cell.isBold()}${cell.isInverse()} `;
    }
    out.push(row.trimEnd());
  }
  return `${out.join("\n")}\n@cursor ${buffer.cursorX},${buffer.cursorY} @buffer ${buffer.type}`;
}

/** Records everything the emulator reports, in order. */
function recordingSink(): TerminalEventSink & {
  readonly titles: string[];
  readonly directories: string[];
  readonly notifications: TerminalNotification[];
  readonly marks: PromptMark[];
} {
  const titles: string[] = [];
  const directories: string[] = [];
  const notifications: TerminalNotification[] = [];
  const marks: PromptMark[] = [];
  return {
    titles,
    directories,
    notifications,
    marks,
    onTitle: (title) => titles.push(title),
    onWorkingDirectory: (path) => directories.push(path),
    onAttention: (notification) => notifications.push(notification),
    onPromptMark: (mark) => marks.push(mark),
    onExit: () => {
      throw new Error("the emulator knows nothing about processes and must never emit onExit");
    },
  };
}

describe("feed", () => {
  test("parses synchronously, so a reused drain buffer is safe to pass by reference", () => {
    // `TerminalBytes` is a view into a buffer the PTY layer reuses every frame. If
    // the emulator parsed it later, the bytes would already be someone else's.
    const target = emulator(20, 3);
    const bytes = encoder.encode("hello world");
    const before = target.revision;

    target.feed(bytes);
    bytes.fill(0x3f);

    expect(target.revision).toBeGreaterThan(before);
    expect(target.snapshotText({ includeScrollback: false })).toBe("hello world");
  });

  test("an empty chunk changes nothing", () => {
    const target = emulator(20, 3);
    feed(target, "text");
    const revision = target.revision;

    target.feed(new Uint8Array(0));

    expect(target.revision).toBe(revision);
  });

  test("repaintSince returns the same empty view when nothing changed", () => {
    const target = emulator(20, 3);
    feed(target, "text");

    const first = target.repaintSince(target.revision);
    const second = target.repaintSince(target.revision);

    expect(first).toHaveLength(0);
    // Polled once per frame per attached client: "nothing changed" must not
    // allocate.
    expect(second).toBe(first);
  });
});

describe("scrollback", () => {
  test("is bounded by the configured number of lines", () => {
    const target = emulator(20, 3, 5);

    for (let line = 0; line < 100; line += 1) {
      feed(target, `line ${line}\r\n`);
    }

    expect(target.snapshotText({ includeScrollback: true }).split("\n")).toHaveLength(7);
  });

  test("createEmulator builds one with the default bound", () => {
    const target = createEmulator({
      size: { columns: 20, rows: 3 },
      scrollback: DEFAULT_SCROLLBACK,
    });

    expect(target.size).toEqual({ columns: 20, rows: 3 });
    expect(target.revision).toBe(0);
  });
});

describe("clearScrollback", () => {
  test("drops history and leaves the visible screen alone", () => {
    const target = emulator(20, 3, 50);
    for (let line = 0; line < 20; line += 1) {
      feed(target, `line ${line}\r\n`);
    }
    const visible = target.snapshotText({ includeScrollback: false });
    const revision = target.revision;

    target.clearScrollback();

    expect(target.snapshotText({ includeScrollback: false })).toBe(visible);
    expect(target.snapshotText({ includeScrollback: true })).toBe(visible);
    // A mirror has to be told the buffer changed, or its next repaint is a
    // no-op over a scrollback it still believes in.
    expect(target.revision).toBeGreaterThan(revision);
  });
});

describe("events", () => {
  test("BEL is attention with no text", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x07");

    expect(sink.notifications).toEqual([{}]);
  });

  test("OSC 9 and OSC 777 are attention with text", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x1b]9;hi\x07\x1b]777;notify;t;b\x07\x1b]9;4;1;50\x07");

    // The last one is a ConEmu progress bar and must not badge a session.
    expect(sink.notifications).toEqual([{ body: "hi" }, { title: "t", body: "b" }]);
  });

  test("OSC 133 marks arrive with their exit code", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x1b]133;A\x07\x1b]133;C\x07\x1b]133;D;1\x07");

    expect(sink.marks).toEqual([
      { kind: "promptStart" },
      { kind: "commandStart" },
      { kind: "commandFinished", exitCode: 1 },
    ]);
  });

  test("OSC 0 and OSC 2 both set the title, with either terminator", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x1b]0;T0\x07\x1b]2;T2\x1b\\");

    expect(sink.titles).toEqual(["T0", "T2"]);
  });

  test("a title longer than the bound is truncated before it leaves", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, `\x1b]0;${"x".repeat(3000)}\x07`);

    expect(sink.titles[0]).toHaveLength(MAX_OSC_TEXT_LENGTH);
  });

  test("OSC 7 reports a local directory and ignores a remote one", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x1b]7;file://localhost/tmp/x%20y\x07\x1b]7;file://elsewhere/tmp\x07");

    expect(sink.directories).toEqual(["/tmp/x y"]);
  });

  test("an unattached emulator swallows its own events", () => {
    const target = emulator(20, 3);

    expect(() => {
      feed(target, "\x07\x1b]0;t\x07\x1b]133;A\x07");
    }).not.toThrow();
  });
});

describe("round trip", () => {
  /** The spike's alternate-screen TUI: the attach case that actually matters. */
  function paintAlternateScreenTui(target: HeadlessEmulator): void {
    feed(target, "\x1b[?1049h\x1b[2J\x1b[H");
    for (let row = 1; row <= 30; row += 1) {
      feed(
        target,
        `\x1b[${row};1H\x1b[4${row % 8}m row ${String(row).padStart(2)} \x1b[0m${"·".repeat(40)}`,
      );
    }
    feed(target, "\x1b[15;25H\x1b[1;97;41m [ MODAL ] \x1b[0m");
    feed(target, "\x1b[30;1H\x1b[7m -- INSERT --                    \x1b[0m");
    feed(target, "\x1b[5;12H");
  }

  test("a full repaint reconstructs colour, truecolor, inverse and wide characters", async () => {
    const source = emulator(80, 24);
    feed(source, "\x1b[H\x1b[2J");
    feed(source, "\x1b[1;31mERROR\x1b[0m plain \x1b[7minverse\x1b[0m\r\n");
    feed(source, "\x1b[38;2;120;200;90mtruecolor\x1b[0m \x1b[44mbg\x1b[0m\r\n");
    feed(source, "\x1b[10;40Hpositioned\r\n");
    feed(source, "box: ┌───┐ ╭─╮ ✓ 中文\r\n");

    const target = receiver(80, 24);
    await replay(target, source.fullRepaint());

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("successive repaints stay correct on a receiver that is already populated", async () => {
    // The reason every repaint carries RIS. `SerializeAddon` emits relative cursor
    // moves and only ever *sets* modes, so replaying it onto a screen that already
    // has content diverges — the second assertion here is the one that fails
    // without the reset prefix.
    const source = emulator(100, 30);
    const target = receiver(100, 30);
    paintAlternateScreenTui(source);

    await replay(target, source.repaintSince(0));

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
    expect(target.buffer.active.type).toBe("alternate");

    const seen = source.revision;
    feed(source, "\x1b[?1049l\x1b[?1h\x1b[2J\x1b[Hback on the normal screen\r\nsecond line");
    const repaint = source.repaintSince(seen);

    expect(repaint.length).toBeGreaterThan(0);
    await replay(target, repaint);

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
    expect(target.buffer.active.type).toBe("normal");
  });

  test("a receiver at the wrong size learns the negotiated grid from the repaint", async () => {
    // The letterbox case, end to end at the byte level: the daemon has resolved
    // the minimum of two viewports to 40×12 and the larger client is still 127×45.
    // Nothing else in the stream says so, so the repaint has to.
    const source = emulator(127, 45);
    source.resize({ columns: 40, rows: 12 });
    feed(source, "\x1b[H\x1b[2Jthis line is forty columns wide, and it wraps at forty");

    const target = receiver(127, 45);
    await replay(target, source.fullRepaint());

    expect({ columns: target.cols, rows: target.rows }).toEqual({ columns: 40, rows: 12 });
    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });
});

describe("resize", () => {
  test("reports the new size and bumps the revision", () => {
    const target = emulator(80, 24);
    const before = target.revision;

    target.resize({ columns: 40, rows: 10 });

    expect(target.size).toEqual({ columns: 40, rows: 10 });
    expect(target.revision).toBeGreaterThan(before);
  });

  test("resizing to the size it already has costs nothing", () => {
    const target = emulator(40, 10);
    target.resize({ columns: 40, rows: 10 });

    expect(target.revision).toBe(0);
  });

  test("reports what the emulator actually holds when it clamps", () => {
    // xterm refuses to go below 2×1. Reporting the request rather than the result
    // would make the negotiated PTY size and the grid disagree.
    const target = emulator(80, 24);

    target.resize({ columns: 1, rows: 0 });

    expect(target.size).toEqual({ columns: 2, rows: 1 });
  });
});

/** The modes a client has to mirror, as the library reports them. */
function dumpModes(target: Terminal): string {
  return JSON.stringify(target.modes);
}

/** Scrollback only: the lines that have left the screen, oldest first. */
function history(target: Terminal): string[] {
  const buffer = target.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.baseY; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return lines;
}

/** Readable in a failure message: which step of a corpus disagreed. */
function escape(text: string): string {
  return text.replaceAll("\x1b", "\\e").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

/**
 * The damage encoder, tested the way the placeholder was: two emulators, and the
 * assertion is that they agree.
 *
 * Each case feeds the source in steps, encodes the delta for a client that saw
 * the previous step, replays it onto a stock receiver and compares the grids and
 * the modes. A step marked `full` is one where a full repaint is the sanctioned
 * answer — a buffer switch, a resize, a RIS — and every other step must be a
 * delta, which is what `expect(text.startsWith(FULL_RESET))` pins.
 */
describe("damage encoder", () => {
  /** A step, and whether a full repaint is the correct answer to it. */
  type Step = string | { readonly feed: string; readonly full: true };

  async function roundTrip(
    source: HeadlessEmulator,
    target: Terminal,
    steps: readonly Step[],
  ): Promise<{ text: string; length: number }[]> {
    await replay(target, source.fullRepaint());
    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
    let seen = source.revision;
    const deltas: { text: string; length: number }[] = [];
    for (const step of steps) {
      const bytes = typeof step === "string" ? step : step.feed;
      const fullAllowed = typeof step !== "string";
      feed(source, bytes);
      const delta = source.repaintSince(seen);
      const text = decoder.decode(delta);
      if (!fullAllowed) {
        expect({ step: escape(bytes), full: text.startsWith("\x1bc") }).toEqual({
          step: escape(bytes),
          full: false,
        });
      }
      // Copied: the delta is a view into a buffer the emulator reuses, and `write`
      // is asynchronous. The steps are a sequence, so each replay finishes first.
      // oxlint-disable-next-line no-await-in-loop -- sequential by nature.
      await replay(target, new Uint8Array(delta));
      expect({ step: escape(bytes), grid: dumpGrid(target) }).toEqual({
        step: escape(bytes),
        grid: dumpGrid(source.terminal),
      });
      expect({ step: escape(bytes), modes: dumpModes(target) }).toEqual({
        step: escape(bytes),
        modes: dumpModes(source.terminal),
      });
      seen = source.revision;
      deltas.push({ text, length: delta.length });
    }
    return deltas;
  }

  test("typing at a prompt sends one row, not a screen", async () => {
    const source = emulator(80, 24);
    const target = receiver(80, 24);
    // A screen with content on every row, so "one row rather than a screen" is a
    // claim with a number behind it.
    for (let row = 0; row < 23; row += 1) {
      feed(source, `filler row ${row} with enough text on it to matter\r\n`);
    }
    feed(source, "$ ");
    const full = source.fullRepaint().length;

    const deltas = await roundTrip(source, target, [
      "l",
      "s",
      " -la",
      "\r\n",
      "total 0\r\n$ ",
      // A short line landing on a long one. Without the row's trailing `EL` the
      // client keeps the tail of what was there — invisible against a fresh
      // receiver, wrong against a real one.
      "\x1b[1;1H\x1b[2Kshort",
    ]);

    for (const delta of deltas.slice(0, 3)) {
      expect(delta.length).toBeLessThan(full / 4);
      // One `CUP` to a row's first column is one row painted. More would mean the
      // library's conservative dirty range went out unfiltered.
      expect(delta.text.split("\x1b[").filter((part) => /^\d+;1H/.test(part))).toHaveLength(1);
    }
  });

  test("colours, truecolor, the 22-for-either-of-bold-and-dim trap, and every flag", async () => {
    const source = emulator(60, 8);
    const target = receiver(60, 8);

    await roundTrip(source, target, [
      "\x1b[31mred \x1b[91mbright \x1b[38;5;200mpalette \x1b[38;2;10;200;30mtruecolor\x1b[0m\r\n",
      "\x1b[41mred bg \x1b[101mbright bg \x1b[48;5;99mpalette bg \x1b[48;2;9;9;9mrgb bg\x1b[0m\r\n",
      "\x1b[1mbold\x1b[22;2mdim\x1b[0m still\r\n",
      "\x1b[7minverse\x1b[27m \x1b[4munderline\x1b[24m \x1b[53moverline\x1b[55m\r\n",
      "\x1b[5mblink\x1b[25m \x1b[8minvisible\x1b[28m \x1b[3mitalic\x1b[23m \x1b[9mstrike\x1b[29m\r\n",
    ]);
  });

  test("wide characters mid-row, at the last column, and overwritten by ASCII", async () => {
    const source = emulator(12, 4);
    const target = receiver(12, 4);

    await roundTrip(source, target, [
      "ab中文cd\r\n",
      // Eleven columns used, so the wide character cannot fit and wraps.
      "\x1b[2;1Hxxxxxxxxxxx中",
      "\x1b[1;3Hzz",
    ]);
  });

  test("combined characters, including one replaced by a different combination", async () => {
    // The packed cell word holds an index rather than the string, so replacing a
    // combined character with another one leaves the word alone. A row holding a
    // combined cell is therefore always treated as changed.
    const source = emulator(12, 4);
    const target = receiver(12, 4);

    await roundTrip(source, target, [
      "e\u0301 a\u0300\r\n",
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\r\n",
      "\x1b[1;1Ho\u0308",
      "\x1b[1;1Hu\u030a",
    ]);
  });

  test("erasures carry the background colour they were erased with", async () => {
    const source = emulator(20, 6);
    const target = receiver(20, 6);

    await roundTrip(source, target, [
      "filled with text here\r\n",
      "\x1b[1;5H\x1b[44m\x1b[K",
      "\x1b[2;1Hsecond row of text\x1b[2;4H\x1b[41m\x1b[5X",
      "\x1b[3;1Hthird\x1b[3;1H\x1b[42m\x1b[2K",
      // Two runs with different backgrounds, side by side, with content between.
      "\x1b[4;1H\x1b[45m\x1b[3X\x1b[3C\x1b[46m\x1b[3X\x1b[3Cmid\x1b[0m",
      "\x1b[5;1H\x1b[43m\x1b[2J",
    ]);
  });

  test("scrolling the normal buffer moves the client's screen and fills its scrollback", async () => {
    const source = emulator(40, 24, 100);
    const target = receiver(40, 24);
    const steps: string[] = [];
    let line = 1;
    for (let batch = 0; batch < 5; batch += 1) {
      let payload = "";
      for (let index = 0; index < 3; index += 1) {
        payload += `line-${String(line).padStart(2, "0")} with a realistic width\r\n`;
        line += 1;
      }
      steps.push(payload);
    }

    // One burst of more lines than rows first, in a single chunk.
    let burst = "";
    for (let index = 0; index < 30; index += 1) {
      burst += `pre-${String(index).padStart(2, "0")} with a realistic width\r\n`;
    }
    const deltas = await roundTrip(source, target, [burst, ...steps]);

    // The client's own screen scrolled, so the lines that left it are in its
    // scrollback, in order. It cannot have the lines from before it attached —
    // `fullRepaint` sends `scrollback: 0` deliberately — so the comparison is of
    // the tail, which is everything the deltas were responsible for.
    expect(target.buffer.active.baseY).toBeGreaterThan(0);
    expect(history(target).slice(-12)).toEqual(history(source.terminal).slice(-12));
    const full = source.fullRepaint().length;
    for (const delta of deltas.slice(1)) {
      expect(delta.length).toBeLessThan(full / 3);
    }
  });

  test("a scroll region falls back to plain row repaints", async () => {
    // Our scroll is a line feed at the bottom row, which would scroll the
    // client's *region* rather than its screen. While a region is set the rows
    // are repainted instead — slower, and the only correct answer.
    const source = emulator(20, 10);
    const target = receiver(20, 10);
    feed(source, "\x1b[1;1Hheader\r\n");

    const deltas = await roundTrip(source, target, [
      "\x1b[3;8r\x1b[3;1H",
      "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n",
      "h\r\ni\r\n",
      "\x1b[r",
      "after\r\n",
    ]);

    // The three steps taken while the region was set carry no line feed; the one
    // after `CSI r` may.
    for (const delta of deltas.slice(0, 3)) {
      expect(delta.text.includes("\n")).toBe(false);
    }
  });

  test("a delta never line-feeds while a scroll region is set", async () => {
    const source = emulator(20, 10);
    const target = receiver(20, 10);
    await replay(target, source.fullRepaint());
    feed(source, "\x1b[3;8r\x1b[3;1H");
    let seen = source.revision;

    for (const step of ["a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n", "g\r\nh\r\n"]) {
      feed(source, step);
      const delta = decoder.decode(source.repaintSince(seen));
      expect(delta.includes("\n")).toBe(false);
      seen = source.revision;
    }
  });

  test("the alternate screen switches with a full repaint and then takes deltas", async () => {
    const source = emulator(40, 10);
    const target = receiver(40, 10);
    feed(source, "normal screen content\r\n");

    await roundTrip(source, target, [
      { feed: "\x1b[?1049h\x1b[2J\x1b[H", full: true },
      "\x1b[3;3Hinside the alternate screen",
      "\x1b[5;1H\x1b[44mstatus\x1b[0m",
      { feed: "\x1b[?1049l", full: true },
      "back on the normal screen\r\n",
    ]);
  });

  test("cursor moves, pending wrap, and hiding the cursor", async () => {
    const source = emulator(10, 5);
    const target = receiver(10, 5);
    const hidden: boolean[] = [];
    target.parser.registerCsiHandler({ prefix: "?", final: "l" }, (parameters) => {
      if (parameters[0] === 25) hidden.push(true);
      return false;
    });
    target.parser.registerCsiHandler({ prefix: "?", final: "h" }, (parameters) => {
      if (parameters[0] === 25) hidden.push(false);
      return false;
    });

    feed(source, "\x1b[1;1Hrow");
    await replay(target, source.fullRepaint());
    let seen = source.revision;

    // A cursor-only step: the reset prefix and one CUP, and nothing else.
    feed(source, "\x1b[4;7H");
    const move = source.repaintSince(seen);
    expect(decoder.decode(move)).toBe("\x1b[0m\x1b[4;7H");
    await replay(target, new Uint8Array(move));
    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
    seen = source.revision;

    // Exactly `cols` characters: the cursor sits past the last column.
    await roundTrip(source, target, ["\x1b[2;1H0123456789", "\x1b[?25l", "\x1b[?25h"]);
    expect(source.terminal.buffer.active.cursorX).toBe(10);
    expect(target.buffer.active.cursorX).toBe(10);
    // Cursor visibility is not in `terminal.modes`, so the receiver records the
    // sequences instead. `SerializeAddon` emits neither of them.
    expect(hidden).toEqual([true, false]);
  });

  test("pending wrap ending in a wide character reprints the character, not the spacer", async () => {
    // The last column is the wide character's second half. Printing a space there
    // to move the cursor past it would erase the character — the defect the
    // seeded fuzz found.
    const source = emulator(6, 3);
    const target = receiver(6, 3);

    await roundTrip(source, target, ["abcd中", "\x1b[2;1Hxx中文"]);
    expect(source.terminal.buffer.active.cursorX).toBe(6);
    expect(target.buffer.active.cursorX).toBe(6);
  });

  test("modes travel with the delta, and a mode-only step paints no row", async () => {
    const source = emulator(20, 4);
    const target = receiver(20, 4);
    feed(source, "content\r\n");

    await roundTrip(source, target, [
      "\x1b[?1h",
      "\x1b[?2004h",
      "\x1b[?1000h\x1b[?1006h",
      "\x1b[4h",
      "\x1b[4l",
      "\x1b[5 q",
      "\x1b[!p",
      "\x1b[?7l",
      "\x1b[?7h",
    ]);

    const seen = source.revision;
    feed(source, "\x1b[?2004l");
    const delta = decoder.decode(source.repaintSince(seen));

    // A mode-only step repaints no row: the row's content never appears in it.
    expect(delta).not.toContain("content");
    expect(delta.includes("\x1b[?2004l")).toBe(true);
  });

  test("a resize is answered with a full repaint carrying the new geometry", async () => {
    const source = emulator(40, 10);
    const target = receiver(40, 10);
    await replay(target, source.fullRepaint());
    feed(source, "content before the resize\r\n");
    const seen = source.revision;

    source.resize({ columns: 20, rows: 6 });
    const delta = source.repaintSince(seen);

    expect(decoder.decode(delta).startsWith("\x1bc")).toBe(true);
    expect(decoder.decode(delta)).toContain("\x1b[8;6;20t");
    await replay(target, new Uint8Array(delta));
    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("a RIS from the program is answered with a full repaint", async () => {
    const source = emulator(20, 5);
    const target = receiver(20, 5);
    await replay(target, source.fullRepaint());
    feed(source, "\x1b[41mcoloured content\r\n");
    const seen = source.revision;

    feed(source, "\x1bcafter the reset");
    const delta = source.repaintSince(seen);

    expect(decoder.decode(delta).startsWith("\x1bc")).toBe(true);
    await replay(target, new Uint8Array(delta));
    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("a chunk that only carried a title costs nothing", async () => {
    const source = emulator(20, 5);
    feed(source, "content\r\n");
    const seen = source.revision;

    feed(source, "\x1b]0;a new title\x07");

    expect(source.revision).toBeGreaterThan(seen);
    expect(source.repaintSince(seen)).toHaveLength(0);
  });

  test("clearing scrollback costs nothing on the wire", async () => {
    const source = emulator(20, 5, 50);
    for (let line = 0; line < 20; line += 1) {
      feed(source, `line ${line}\r\n`);
    }
    const seen = source.revision;

    source.clearScrollback();

    expect(source.repaintSince(seen)).toHaveLength(0);
  });

  test("a client from the future or further behind than the scroll ring gets a full repaint", async () => {
    const source = emulator(20, 5);
    feed(source, "content\r\n");

    expect(decoder.decode(source.repaintSince(source.revision + 5)).startsWith("\x1bc")).toBe(true);

    for (let index = 0; index < SCROLL_RING + 2; index += 1) {
      feed(source, `line ${index}\r\n`);
    }

    expect(decoder.decode(source.repaintSince(1)).startsWith("\x1bc")).toBe(true);
  });

  test("under a flood the delta tracks the screen, not the throughput", async () => {
    const source = emulator(80, 24, 100);
    const target = receiver(80, 24);
    await replay(target, source.fullRepaint());
    const budget = Math.floor(2e6 / 120);
    const frame = "y\r\n".repeat(Math.floor(833_333 / 3));
    let seen = source.revision;
    const lengths: number[] = [];
    const buffers: ArrayBufferLike[] = [];

    for (let index = 0; index < 10; index += 1) {
      feed(source, frame);
      const delta = source.repaintSince(seen);
      expect(delta.length).toBeLessThanOrEqual(budget);
      lengths.push(delta.length);
      buffers.push(delta.buffer);
      // oxlint-disable-next-line no-await-in-loop -- one frame after another is the point.
      await replay(target, new Uint8Array(delta));
      seen = source.revision;
    }

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
    // Twice the bytes, the same screen: the wire cost is the grid's, not the
    // flood's.
    feed(source, frame + frame);
    const doubled = source.repaintSince(seen);
    expect(doubled.length).toBeLessThanOrEqual(budget);
    seen = source.revision;
    // One allocation, reused: the frame loop copies each view before the next.
    expect(new Set(buffers).size).toBe(1);
    expect(lengths[9]).toBe(lengths[8]);

    expect(source.repaintSince(seen)).toHaveLength(0);
  });

  test("the fallback that diffs every row is just as correct", async () => {
    // What runs if a library bump takes the per-parse dirty rows away.
    const source = new HeadlessEmulator({ columns: 20, rows: 8 }, 100, { rowHints: false });
    const target = receiver(20, 8);
    expect(source.rowHints).toBe(false);

    await roundTrip(source, target, [
      "$ ",
      "ls",
      "\r\n",
      "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\n",
      "\x1b[41mcoloured\x1b[0m\r\n",
    ]);
  });

  test("the library still hands us per-parse dirty rows", () => {
    // A bump that removes `onRequestRefreshRows` turns this red rather than
    // quietly halving the encoder's throughput.
    expect(emulator(20, 5).rowHints).toBe(true);
  });

  test("300 seeded random steps round-trip identically", async () => {
    const source = emulator(40, 12, 200);
    const target = receiver(40, 12);
    await replay(target, source.fullRepaint());
    let seed = 0x32;
    const random = (bound: number): number => {
      // A tiny LCG: reproducible, and the failure message carries the step.
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    const generators: readonly ((rows: number, columns: number) => Step)[] = [
      (rows, columns) => `\x1b[${1 + random(rows)};${1 + random(columns)}H`,
      () => "text".repeat(1 + random(4)),
      () => `\x1b[3${random(8)};4${random(8)}mcoloured`,
      () => `\x1b[${random(3)}m`,
      () => "\r\n".repeat(1 + random(5)),
      () => `\x1b[${1 + random(6)}X`,
      () => `\x1b[${random(3)}K`,
      () => `\x1b[${random(3)}J`,
      (rows) => `\x1b[${1 + random(rows / 2)};${rows}r`,
      () => "\x1b[r",
      () => "中文",
      () => "e\u0301",
      () => (random(2) === 0 ? "\x1b[?25l" : "\x1b[?25h"),
      () => (random(2) === 0 ? "\x1b[4h" : "\x1b[4l"),
      () => ({ feed: random(2) === 0 ? "\x1b[?1049h" : "\x1b[?1049l", full: true }),
    ];

    let seen = source.revision;
    for (let index = 0; index < 300; index += 1) {
      const generator = generators[random(generators.length)];
      if (generator === undefined) {
        continue;
      }
      const step = generator(12, 40);
      const bytes = typeof step === "string" ? step : step.feed;
      feed(source, bytes);
      const delta = source.repaintSince(seen);
      // oxlint-disable-next-line no-await-in-loop -- one frame after another is the point.
      await replay(target, new Uint8Array(delta));
      expect({ index, step: escape(bytes), grid: dumpGrid(target) }).toEqual({
        index,
        step: escape(bytes),
        grid: dumpGrid(source.terminal),
      });
      expect({ index, step: escape(bytes), modes: dumpModes(target) }).toEqual({
        index,
        step: escape(bytes),
        modes: dumpModes(source.terminal),
      });
      seen = source.revision;
    }
  });
});
