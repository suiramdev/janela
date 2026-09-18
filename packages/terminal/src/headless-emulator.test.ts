import { describe, expect, test } from "bun:test";

import { agentActivityEscape, type AgentActivity, type TerminalProgress } from "@janela/core";
import { Terminal } from "@xterm/headless";
import { Predicate } from "effect";

import { createEmulator, HeadlessEmulator, SCROLL_RING } from "./headless-emulator.ts";
import {
  DEFAULT_SCROLLBACK,
  MAX_OSC_TEXT_LENGTH,
  type PromptMark,
  type TerminalEventSink,
  type TerminalNotification,
} from "./terminal-emulating.ts";

interface Step {
  readonly feed: string;
  readonly fullAllowed: boolean;
}

interface Delta {
  readonly text: string;
  readonly length: number;
}

interface RecordingSink extends TerminalEventSink {
  readonly titles: string[];
  readonly directories: string[];
  readonly notifications: TerminalNotification[];
  readonly marks: PromptMark[];
  readonly progress: (TerminalProgress | undefined)[];
  readonly activities: AgentActivity[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FULL_REPAINT_PREFIX = "\x1bc";

const SET_WINDOW_SIZE_CHARS = 8;

function emulator(columns: number, rows: number, scrollback = 100): HeadlessEmulator {
  return new HeadlessEmulator({ columns, rows }, scrollback, { rowHints: true });
}

function feed(target: HeadlessEmulator, data: string): void {
  target.feed(encoder.encode(data));
}

function delta(feedBytes: string): Step {
  return { feed: feedBytes, fullAllowed: false };
}

function fullRepaintIsAllowed(feedBytes: string): Step {
  return { feed: feedBytes, fullAllowed: true };
}

function receiver(columns: number, rows: number): Terminal {
  const target = new Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    logLevel: "off",
    windowOptions: { setWinSizeChars: true },
  });
  target.parser.registerCsiHandler({ final: "t" }, (parameters) => {
    if (parameters[0] !== SET_WINDOW_SIZE_CHARS) return false;

    const announcedRows = parameters[1];
    const announcedColumns = parameters[2];

    if (!Predicate.isNumber(announcedRows) || !Predicate.isNumber(announcedColumns)) return true;

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

      row +=
        `${cell.getChars() || " "}|${cell.getFgColor()}/${cell.getBgColor()}/` +
        `${cell.isBold()}${cell.isDim()}${cell.isItalic()}${cell.isUnderline()}` +
        `${cell.isBlink()}${cell.isInverse()}${cell.isInvisible()}` +
        `${cell.isStrikethrough()}${cell.isOverline()} `;
    }

    out.push(row.trimEnd());
  }

  return `${out.join("\n")}\n@cursor ${buffer.cursorX},${buffer.cursorY} @buffer ${buffer.type}`;
}

function dumpModes(target: Terminal): string {
  return JSON.stringify(target.modes);
}

function history(target: Terminal): string[] {
  const buffer = target.buffer.active;
  const lines: string[] = [];

  for (let y = 0; y < buffer.baseY; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }

  return lines;
}

function escape(text: string): string {
  return text.replaceAll("\x1b", "\\e").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function recordingSink(): RecordingSink {
  const titles: string[] = [];
  const directories: string[] = [];
  const notifications: TerminalNotification[] = [];
  const marks: PromptMark[] = [];
  const progress: (TerminalProgress | undefined)[] = [];
  const activities: AgentActivity[] = [];

  return {
    titles,
    directories,
    notifications,
    marks,
    progress,
    activities,
    onTitle: (title) => titles.push(title),
    onWorkingDirectory: (path) => directories.push(path),
    onAttention: (notification) => notifications.push(notification),
    onPromptMark: (mark) => marks.push(mark),
    onProgress: (reported) => progress.push(reported),
    onActivity: (activity) => activities.push(activity),
    onExit: () => {
      throw new Error("the emulator knows nothing about processes and must never emit onExit");
    },
  };
}

describe("feed", () => {
  test("parses synchronously, so a reused drain buffer is safe to pass by reference", () => {
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

  test("repaintSince returns the same shared empty view when nothing changed", () => {
    const target = emulator(20, 3);
    feed(target, "text");

    const first = target.repaintSince(target.revision);
    const second = target.repaintSince(target.revision);

    expect(first).toHaveLength(0);
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
  test("drops history, leaves the visible screen alone, and still bumps the revision", () => {
    const target = emulator(20, 3, 50);

    for (let line = 0; line < 20; line += 1) {
      feed(target, `line ${line}\r\n`);
    }

    const visible = target.snapshotText({ includeScrollback: false });
    const revision = target.revision;

    target.clearScrollback();

    expect(target.snapshotText({ includeScrollback: false })).toBe(visible);
    expect(target.snapshotText({ includeScrollback: true })).toBe(visible);
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

  test("OSC 9 and OSC 777 are attention with text, and a ConEmu progress bar is progress", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "\x1b]9;hi\x07\x1b]777;notify;t;b\x07\x1b]9;4;1;50\x07");

    expect(sink.notifications).toEqual([{ body: "hi" }, { title: "t", body: "b" }]);
    expect(sink.progress).toEqual([{ kind: "normal", percent: 50 }]);
  });

  test("OSC 9;4 reports every state, clears on 0, and ignores malformed payloads", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(
      target,
      "\x1b]9;4;3\x07\x1b]9;4;2;101\x07\x1b]9;4;4;-5\x07\x1b]9;4;1\x07" +
        "\x1b]9;4;0\x07\x1b]9;4;9;50\x07\x1b]9;4;1;half\x07",
    );

    expect(sink.progress).toEqual([
      { kind: "indeterminate" },
      { kind: "error", percent: 100 },
      { kind: "warning", percent: 0 },
      { kind: "normal", percent: 0 },
      undefined,
    ]);
    expect(sink.notifications).toEqual([]);
  });

  test("OSC 7770 reports an agent's activity, ignores a bogus payload, and paints nothing", () => {
    const target = emulator(20, 3);
    const sink = recordingSink();
    target.events = sink;

    feed(target, "screen");

    const revision = target.revision;

    feed(target, agentActivityEscape({ kind: "waiting", need: "permission" }));
    feed(target, "\x1b]7770;bogus\x07");

    expect(sink.activities).toEqual([{ kind: "waiting", need: "permission" }]);
    expect(target.snapshotText({ includeScrollback: true })).toBe("screen");
    expect(target.repaintSince(revision)).toHaveLength(0);
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

  test("reports what the emulator actually holds when it clamps below two by one", () => {
    const target = emulator(80, 24);

    target.resize({ columns: 1, rows: 0 });

    expect(target.size).toEqual({ columns: 2, rows: 1 });
  });
});

describe("damage encoder", () => {
  async function roundTrip(
    source: HeadlessEmulator,
    target: Terminal,
    steps: readonly Step[],
  ): Promise<Delta[]> {
    await replay(target, source.fullRepaint());

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));

    let seen = source.revision;
    const deltas: Delta[] = [];

    for (const step of steps) {
      feed(source, step.feed);

      const bytes = source.repaintSince(seen);
      const text = decoder.decode(bytes);

      if (!step.fullAllowed) {
        expect({ step: escape(step.feed), full: text.startsWith(FULL_REPAINT_PREFIX) }).toEqual({
          step: escape(step.feed),
          full: false,
        });
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential by nature.
      await replay(target, new Uint8Array(bytes));

      expect({ step: escape(step.feed), grid: dumpGrid(target) }).toEqual({
        step: escape(step.feed),
        grid: dumpGrid(source.terminal),
      });
      expect({ step: escape(step.feed), modes: dumpModes(target) }).toEqual({
        step: escape(step.feed),
        modes: dumpModes(source.terminal),
      });

      seen = source.revision;
      deltas.push({ text, length: bytes.length });
    }

    return deltas;
  }

  test("typing at a prompt sends one row, not a screen", async () => {
    const source = emulator(80, 24);
    const target = receiver(80, 24);

    for (let row = 0; row < 23; row += 1) {
      feed(source, `filler row ${row} with enough text on it to matter\r\n`);
    }

    feed(source, "$ ");

    const full = source.fullRepaint().length;
    const deltas = await roundTrip(source, target, [
      delta("l"),
      delta("s"),
      delta(" -la"),
      delta("\r\n"),
      delta("total 0\r\n$ "),
      delta("\x1b[1;1H\x1b[2Kshort"),
    ]);

    for (const encoded of deltas.slice(0, 3)) {
      expect(encoded.length).toBeLessThan(full / 4);
      expect(encoded.text.split("\x1b[").filter((part) => /^\d+;1H/.test(part))).toHaveLength(1);
    }
  });

  test("colours, truecolor, the 22-for-either-of-bold-and-dim trap, and every flag", async () => {
    const source = emulator(60, 8);
    const target = receiver(60, 8);

    await roundTrip(source, target, [
      delta(
        "\x1b[31mred \x1b[91mbright \x1b[38;5;200mpalette \x1b[38;2;10;200;30mtruecolor\x1b[0m\r\n",
      ),
      delta(
        "\x1b[41mred bg \x1b[101mbright bg \x1b[48;5;99mpalette bg \x1b[48;2;9;9;9mrgb bg\x1b[0m\r\n",
      ),
      delta("\x1b[1mbold\x1b[22;2mdim\x1b[0m still\r\n"),
      delta("\x1b[2mdim\x1b[22;1mbold\x1b[0m still\r\n"),
      delta("\x1b[7minverse\x1b[27m \x1b[4munderline\x1b[24m \x1b[53moverline\x1b[55m\r\n"),
      delta(
        "\x1b[5mblink\x1b[25m \x1b[8minvisible\x1b[28m \x1b[3mitalic\x1b[23m \x1b[9mstrike\x1b[29m\r\n",
      ),
    ]);
  });

  test("wide characters mid-row, at the last column, and overwritten by ASCII", async () => {
    const source = emulator(12, 4);
    const target = receiver(12, 4);

    await roundTrip(source, target, [
      delta("ab中文cd\r\n"),
      delta("\x1b[2;1Hxxxxxxxxxxx中"),
      delta("\x1b[1;3Hzz"),
    ]);
  });

  test("combined characters, including one replaced by a different combination", async () => {
    const source = emulator(12, 4);
    const target = receiver(12, 4);

    await roundTrip(source, target, [
      delta("e\u0301 a\u0300\r\n"),
      delta("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\r\n"),
      delta("\x1b[1;1Ho\u0308"),
      delta("\x1b[1;1Hu\u030a"),
    ]);
  });

  test("erasures carry the background colour they were erased with", async () => {
    const source = emulator(20, 6);
    const target = receiver(20, 6);

    await roundTrip(source, target, [
      delta("filled with text here\r\n"),
      delta("\x1b[1;5H\x1b[44m\x1b[K"),
      delta("\x1b[2;1Hsecond row of text\x1b[2;4H\x1b[41m\x1b[5X"),
      delta("\x1b[3;1Hthird\x1b[3;1H\x1b[42m\x1b[2K"),
      delta("\x1b[4;1H\x1b[45m\x1b[3X\x1b[3C\x1b[46m\x1b[3X\x1b[3Cmid\x1b[0m"),
      delta("\x1b[5;1H\x1b[43m\x1b[2J"),
    ]);
  });

  test("scrolling the normal buffer moves the client's screen and fills its scrollback", async () => {
    const source = emulator(40, 24, 100);
    const target = receiver(40, 24);
    const steps: Step[] = [];
    let line = 1;

    for (let batch = 0; batch < 5; batch += 1) {
      let payload = "";

      for (let index = 0; index < 3; index += 1) {
        payload += `line-${String(line).padStart(2, "0")} with a realistic width\r\n`;
        line += 1;
      }

      steps.push(delta(payload));
    }

    let burst = "";

    for (let index = 0; index < 30; index += 1) {
      burst += `pre-${String(index).padStart(2, "0")} with a realistic width\r\n`;
    }

    const deltas = await roundTrip(source, target, [delta(burst), ...steps]);

    expect(target.buffer.active.baseY).toBeGreaterThan(0);
    expect(history(target).slice(-12)).toEqual(history(source.terminal).slice(-12));

    const full = source.fullRepaint().length;

    for (const encoded of deltas.slice(1)) {
      expect(encoded.length).toBeLessThan(full / 3);
    }
  });

  test("a scroll region falls back to plain row repaints, never a line feed", async () => {
    const source = emulator(20, 10);
    const target = receiver(20, 10);
    feed(source, "\x1b[1;1Hheader\r\n");

    const deltas = await roundTrip(source, target, [
      delta("\x1b[3;8r\x1b[3;1H"),
      delta("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n"),
      delta("h\r\ni\r\n"),
      delta("\x1b[r"),
      delta("after\r\n"),
    ]);

    for (const encoded of deltas.slice(0, 3)) {
      expect(encoded.text.includes("\n")).toBe(false);
    }
  });

  test("a client the region outlives still receives no line feed", async () => {
    const source = emulator(20, 10);
    const target = receiver(20, 10);
    await replay(target, source.fullRepaint());
    feed(source, "\x1b[3;8r\x1b[3;1H");

    let seen = source.revision;

    for (const step of ["a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n", "g\r\nh\r\n"]) {
      feed(source, step);

      const encoded = decoder.decode(source.repaintSince(seen));

      expect(encoded.includes("\n")).toBe(false);

      seen = source.revision;
    }
  });

  test("the alternate screen switches with a full repaint and then takes deltas", async () => {
    const source = emulator(40, 10);
    const target = receiver(40, 10);
    feed(source, "normal screen content\r\n");

    await roundTrip(source, target, [
      fullRepaintIsAllowed("\x1b[?1049h\x1b[2J\x1b[H"),
      delta("\x1b[3;3Hinside the alternate screen"),
      delta("\x1b[5;1H\x1b[44mstatus\x1b[0m"),
      fullRepaintIsAllowed("\x1b[?1049l"),
      delta("back on the normal screen\r\n"),
    ]);
  });

  test("cursor moves, pending wrap, and hiding the cursor the serialiser would drop", async () => {
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
    feed(source, "\x1b[4;7H");

    const move = source.repaintSince(seen);

    expect(decoder.decode(move)).toBe("\x1b[0m\x1b[4;7H");

    await replay(target, new Uint8Array(move));

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));

    seen = source.revision;
    await roundTrip(source, target, [
      delta("\x1b[2;1H0123456789"),
      delta("\x1b[?25l"),
      delta("\x1b[?25h"),
    ]);

    expect(source.terminal.buffer.active.cursorX).toBe(10);
    expect(target.buffer.active.cursorX).toBe(10);
    expect(hidden).toEqual([true, false]);
  });

  test("pending wrap ending in a wide character reprints the character, not the spacer", async () => {
    const source = emulator(6, 3);
    const target = receiver(6, 3);

    await roundTrip(source, target, [delta("abcd中"), delta("\x1b[2;1Hxx中文")]);

    expect(source.terminal.buffer.active.cursorX).toBe(6);
    expect(target.buffer.active.cursorX).toBe(6);
  });

  test("a client that missed several scrolling frames catches up in one delta", async () => {
    const source = emulator(30, 24, 100);
    const target = receiver(30, 24);

    for (let row = 1; row <= 24; row += 1) {
      feed(source, `\x1b[${row};1Horiginal row ${row}`);
    }

    await replay(target, source.fullRepaint());

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));

    const seen = source.revision;

    for (let step = 0; step < 2; step += 1) {
      feed(source, "\x1b[24;1H\n\n");
      feed(source, `\x1b[20;1Hrewritten by step ${step}`);
    }

    const bytes = source.repaintSince(seen);

    expect(decoder.decode(bytes).startsWith(FULL_REPAINT_PREFIX)).toBe(false);

    await replay(target, new Uint8Array(bytes));

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("a full repaint carries the three modes the serialiser omits, both ways", async () => {
    const source = emulator(20, 5);
    feed(source, "\x1b[?25l\x1b[?1006h\x1b[5 qcontent");

    const full = decoder.decode(source.fullRepaint());

    expect(full).toContain("\x1b[?25l");
    expect(full).toContain("\x1b[?1006h");
    expect(full).toContain("\x1b[5 q");

    feed(source, "\x1b[?25h\x1b[?1006l\x1b[0 q");

    const plain = decoder.decode(source.fullRepaint());

    expect(plain).not.toContain("\x1b[?25l");
    expect(plain).not.toContain("\x1b[?1006h");
    expect(plain).not.toContain(" q");
  });

  test("modes travel with the delta, and a mode-only step paints no row", async () => {
    const source = emulator(20, 4);
    const target = receiver(20, 4);
    feed(source, "content\r\n");

    await roundTrip(source, target, [
      delta("\x1b[?1h"),
      delta("\x1b[?2004h"),
      delta("\x1b[?1000h\x1b[?1006h"),
      delta("\x1b[4h"),
      delta("\x1b[4l"),
      delta("\x1b[5 q"),
      delta("\x1b[!p"),
      delta("\x1b[?7l"),
      delta("\x1b[?7h"),
    ]);

    const seen = source.revision;
    feed(source, "\x1b[?2004l");

    const encoded = decoder.decode(source.repaintSince(seen));

    expect(encoded).not.toContain("content");
    expect(encoded.includes("\x1b[?2004l")).toBe(true);
  });

  test("a resize is answered with a full repaint carrying the new geometry", async () => {
    const source = emulator(40, 10);
    const target = receiver(40, 10);
    await replay(target, source.fullRepaint());
    feed(source, "content before the resize\r\n");

    const seen = source.revision;

    source.resize({ columns: 20, rows: 6 });

    const bytes = source.repaintSince(seen);

    expect(decoder.decode(bytes).startsWith(FULL_REPAINT_PREFIX)).toBe(true);
    expect(decoder.decode(bytes)).toContain("\x1b[8;6;20t");

    await replay(target, new Uint8Array(bytes));

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("a RIS from the program is answered with a full repaint", async () => {
    const source = emulator(20, 5);
    const target = receiver(20, 5);
    await replay(target, source.fullRepaint());
    feed(source, "\x1b[41mcoloured content\r\n");

    const seen = source.revision;

    feed(source, "\x1bcafter the reset");

    const bytes = source.repaintSince(seen);

    expect(decoder.decode(bytes).startsWith(FULL_REPAINT_PREFIX)).toBe(true);

    await replay(target, new Uint8Array(bytes));

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));
  });

  test("a chunk that only carried a title costs nothing on the wire", () => {
    const source = emulator(20, 5);
    feed(source, "content\r\n");

    const seen = source.revision;

    feed(source, "\x1b]0;a new title\x07");

    expect(source.revision).toBeGreaterThan(seen);
    expect(source.repaintSince(seen)).toHaveLength(0);
  });

  test("clearing scrollback costs nothing on the wire", () => {
    const source = emulator(20, 5, 50);

    for (let line = 0; line < 20; line += 1) {
      feed(source, `line ${line}\r\n`);
    }

    const seen = source.revision;

    source.clearScrollback();

    expect(source.repaintSince(seen)).toHaveLength(0);
  });

  test("a client from the future or further behind than the scroll ring gets a full repaint", () => {
    const source = emulator(20, 5);
    feed(source, "content\r\n");

    expect(
      decoder.decode(source.repaintSince(source.revision + 5)).startsWith(FULL_REPAINT_PREFIX),
    ).toBe(true);

    for (let index = 0; index < SCROLL_RING + 2; index += 1) {
      feed(source, `line ${index}\r\n`);
    }

    expect(decoder.decode(source.repaintSince(1)).startsWith(FULL_REPAINT_PREFIX)).toBe(true);
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

      const bytes = source.repaintSince(seen);

      expect(bytes.length).toBeLessThanOrEqual(budget);

      lengths.push(bytes.length);
      buffers.push(bytes.buffer);
      // oxlint-disable-next-line no-await-in-loop -- one frame after another is the point.
      await replay(target, new Uint8Array(bytes));
      seen = source.revision;
    }

    expect(dumpGrid(target)).toBe(dumpGrid(source.terminal));

    feed(source, frame + frame);

    const doubled = source.repaintSince(seen);

    expect(doubled.length).toBeLessThanOrEqual(budget);

    seen = source.revision;

    expect(new Set(buffers).size).toBe(1);
    expect(lengths[9]).toBe(lengths[8]);
    expect(source.repaintSince(seen)).toHaveLength(0);
  }, 30_000);

  test("the fallback that diffs every row is just as correct", async () => {
    const source = new HeadlessEmulator({ columns: 20, rows: 8 }, 100, { rowHints: false });
    const target = receiver(20, 8);

    expect(source.rowHints).toBe(false);

    await roundTrip(source, target, [
      delta("$ "),
      delta("ls"),
      delta("\r\n"),
      delta("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\n"),
      delta("\x1b[41mcoloured\x1b[0m\r\n"),
    ]);
  });

  test("the library still hands us per-parse dirty rows", () => {
    expect(emulator(20, 5).rowHints).toBe(true);
  });

  test("300 seeded random steps round-trip identically", async () => {
    const source = emulator(40, 12, 200);
    const target = receiver(40, 12);
    await replay(target, source.fullRepaint());

    let seed = 0x32;

    const random = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

      return seed % bound;
    };

    const generators: readonly ((rows: number, columns: number) => Step)[] = [
      (rows, columns) => delta(`\x1b[${1 + random(rows)};${1 + random(columns)}H`),
      () => delta("text".repeat(1 + random(4))),
      () => delta(`\x1b[3${random(8)};4${random(8)}mcoloured`),
      () => delta(`\x1b[${random(3)}m`),
      () => delta("\r\n".repeat(1 + random(5))),
      () => delta(`\x1b[${1 + random(6)}X`),
      () => delta(`\x1b[${random(3)}K`),
      () => delta(`\x1b[${random(3)}J`),
      (rows) => delta(`\x1b[${1 + random(rows / 2)};${rows}r`),
      () => delta("\x1b[r"),
      () => delta("中文"),
      () => delta("e\u0301"),
      () => delta(random(2) === 0 ? "\x1b[?25l" : "\x1b[?25h"),
      () => delta(random(2) === 0 ? "\x1b[4h" : "\x1b[4l"),
      () => fullRepaintIsAllowed(random(2) === 0 ? "\x1b[?1049h" : "\x1b[?1049l"),
    ];

    let seen = source.revision;

    for (let index = 0; index < 300; index += 1) {
      const generator = generators[random(generators.length)];

      if (generator === undefined) {
        continue;
      }

      const step = generator(12, 40);
      feed(source, step.feed);

      const bytes = source.repaintSince(seen);
      // oxlint-disable-next-line no-await-in-loop -- one frame after another is the point.
      await replay(target, new Uint8Array(bytes));

      expect({ index, step: escape(step.feed), grid: dumpGrid(target) }).toEqual({
        index,
        step: escape(step.feed),
        grid: dumpGrid(source.terminal),
      });
      expect({ index, step: escape(step.feed), modes: dumpModes(target) }).toEqual({
        index,
        step: escape(step.feed),
        modes: dumpModes(source.terminal),
      });

      seen = source.revision;
    }
  }, 30_000);
});
