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

import { createEmulator, HeadlessEmulator } from "./headless-emulator.ts";
import {
  DEFAULT_SCROLLBACK,
  MAX_OSC_TEXT_LENGTH,
  type PromptMark,
  type TerminalEventSink,
  type TerminalNotification,
} from "./terminal-emulating.ts";

const encoder = new TextEncoder();

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
