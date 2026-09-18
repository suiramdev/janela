// oxlint-disable no-underscore-dangle -- `_core`, `_inputHandler` and `_data` are the library's own member names; `libraryInternals` validates each one and names what moved.

import { hostname } from "node:os";

import { AGENT_ACTIVITY_OSC, parseAgentActivity, type GridSize } from "@janela/core";
import type { TerminalBytes } from "@janela/pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { Predicate } from "effect";

import {
  parseNotification,
  parseProgress,
  parsePromptMark,
  parseUrxvtNotification,
  parseWorkingDirectory,
  sanitiseOscText,
} from "./osc.ts";
import {
  RepaintEncoder,
  type LoadedCell,
  type ModeState,
  type MouseEncoding,
  type RowCells,
} from "./repaint-encoder.ts";
import type { TerminalEmulating, TerminalEventSink } from "./terminal-emulating.ts";

export interface EmulatorOptions {
  readonly rowHints: boolean;
}

interface InternalLine extends RowCells {
  readonly _data: Uint32Array;
}

interface InternalBuffer {
  readonly ybase: number;
  readonly x: number;
  readonly y: number;
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly lines: { get(index: number): InternalLine | undefined };
  getNullCell(): LoadedCell;
}

interface RefreshRange {
  readonly start: number;
  readonly end: number;
}

interface InternalCore {
  readonly buffer: InternalBuffer;
  readonly _inputHandler: {
    onRequestRefreshRows?: (listener: (range: RefreshRange | undefined) => void) => void;
  };
}

interface InternalTerminal extends Terminal {
  readonly _core?: InternalCore;
}

interface LibraryInternals {
  readonly core: InternalCore;
  readonly cell: LoadedCell;
  readonly rowHints: boolean;
}

const encoder = new TextEncoder();

const EMPTY = new Uint8Array(0);

const CLEAR_SCROLLBACK = encoder.encode("\x1b[3J");

const FULL_RESET = "\x1bc";

export const SCROLL_RING = 128;

const WORDS_PER_CELL = 3;

const COMBINED_FLAG = 0x20_00_00;

const CURSOR_VISIBILITY_MODE = 25;
const SGR_MOUSE_MODE = 1006;
const SGR_PIXEL_MOUSE_MODE = 1016;

const DEFAULT_CURSOR_STYLE = 0;

const NO_ROW: RowCells = {
  length: 0,
  loadCell: () => {},
};

function libraryInternals(terminal: Terminal): LibraryInternals {
  /* SAFETY: `_core` is declared optional and nothing is read off it before the
     checks below, each of which throws naming the member that moved: `_core`
     itself, `buffer.lines.get`, the scroll region, `BufferLine._data` and its
     cell width, `BufferLine.loadCell`, `buffer.getNullCell` and the cell's
     `content`/`combinedData`. The assertion therefore states only which shape to
     look for; the evidence that the shape is real is established here, before
     `HeadlessEmulator` reaches for any of it. */
  const internal = terminal as InternalTerminal;
  const core = internal._core;

  if (core === undefined || !Predicate.isObject(core)) {
    throw new Error("@xterm/headless internals changed: no _core");
  }

  const buffer = core.buffer;

  if (buffer === undefined || !Predicate.isFunction(buffer.lines?.get)) {
    throw new Error("@xterm/headless internals changed: _core.buffer.lines.get");
  }

  if (!Predicate.isNumber(buffer.scrollTop) || !Predicate.isNumber(buffer.scrollBottom)) {
    throw new Error("@xterm/headless internals changed: buffer scroll region");
  }

  const line = buffer.lines.get(0);

  if (line === undefined || !(line._data instanceof Uint32Array)) {
    throw new Error("@xterm/headless internals changed: BufferLine._data");
  }

  if (line._data.length !== terminal.cols * WORDS_PER_CELL) {
    throw new Error("@xterm/headless internals changed: BufferLine._data cell width");
  }

  if (!Predicate.isFunction(line.loadCell)) {
    throw new Error("@xterm/headless internals changed: BufferLine.loadCell");
  }

  if (!Predicate.isFunction(buffer.getNullCell)) {
    throw new Error("@xterm/headless internals changed: buffer.getNullCell");
  }

  const cell = buffer.getNullCell();

  if (!Predicate.isNumber(cell.content) || !Predicate.isString(cell.combinedData)) {
    throw new Error("@xterm/headless internals changed: CellData content/combinedData");
  }

  return {
    core,
    cell,
    rowHints: Predicate.isFunction(core._inputHandler?.onRequestRefreshRows),
  };
}

export class HeadlessEmulator implements TerminalEmulating {
  readonly terminal: Terminal;

  events: TerminalEventSink | undefined;

  readonly rowHints: boolean;

  private readonly serializer = new SerializeAddon();
  private currentSize: GridSize;
  private currentRevision = 0;
  private parsed = false;
  private readonly markParsed = (): void => {
    this.parsed = true;
  };
  private readonly hostName = hostname();

  private readonly core: InternalCore;
  private readonly cell: LoadedCell;

  private readonly encoder = new RepaintEncoder();

  private shadow: Uint32Array;
  private changedAt: Float64Array;
  private readonly scrollAt = new Uint32Array(SCROLL_RING);

  private fullFloor = 0;
  private cursorChangedAt = 0;
  private modesChangedAt = 0;
  private cursorX = 0;
  private cursorY = 0;

  private readonly modeState: ModeState = {
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
    cursorStyle: DEFAULT_CURSOR_STYLE,
  };

  private cursorVisible = true;
  private mouseEncoding: MouseEncoding = "default";
  private cursorStyle = DEFAULT_CURSOR_STYLE;

  private dirtyStart = 0;
  private dirtyEnd = -1;
  private dirtyAll = false;
  private scrolls = 0;
  private regionTouched = false;
  private modesTouched = false;
  private invalidate = false;

  constructor(size: GridSize, scrollback: number, options: EmulatorOptions) {
    this.terminal = new Terminal({
      cols: size.columns,
      rows: size.rows,
      scrollback,
      allowProposedApi: true,
      logLevel: "off",
    });
    this.terminal.loadAddon(this.serializer);
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };

    const internals = libraryInternals(this.terminal);
    this.core = internals.core;
    this.cell = internals.cell;
    this.rowHints = internals.rowHints && options.rowHints;

    this.shadow = new Uint32Array(
      this.currentSize.rows * this.currentSize.columns * WORDS_PER_CELL,
    );
    this.changedAt = new Float64Array(this.currentSize.rows);
    this.encoder.reserve(this.currentSize);

    this.terminal.onBell(() => {
      this.events?.onAttention({});
    });
    this.terminal.onTitleChange((title) => {
      this.events?.onTitle(sanitiseOscText(title));
    });

    this.terminal.parser.registerOscHandler(7, (payload) => {
      const directory = parseWorkingDirectory(payload, this.hostName);

      if (directory !== undefined) {
        this.events?.onWorkingDirectory(directory);
      }

      return true;
    });
    this.terminal.parser.registerOscHandler(9, (payload) => {
      const progress = parseProgress(payload);

      if (progress !== undefined) {
        this.events?.onProgress(progress.kind === "cleared" ? undefined : progress.progress);

        return true;
      }

      const notification = parseNotification(payload);

      if (notification !== undefined) {
        this.events?.onAttention(notification);
      }

      return true;
    });
    this.terminal.parser.registerOscHandler(777, (payload) => {
      const notification = parseUrxvtNotification(payload);

      if (notification !== undefined) {
        this.events?.onAttention(notification);
      }

      return true;
    });
    this.terminal.parser.registerOscHandler(133, (payload) => {
      const mark = parsePromptMark(payload);

      if (mark !== undefined) {
        this.events?.onPromptMark(mark);
      }

      return true;
    });
    this.terminal.parser.registerOscHandler(AGENT_ACTIVITY_OSC, (payload) => {
      const activity = parseAgentActivity(payload);

      if (activity !== undefined) {
        this.events?.onActivity(activity);
      }

      return true;
    });

    this.registerDamageListeners();
    this.resync();
  }

  get size(): GridSize {
    return this.currentSize;
  }

  get revision(): number {
    return this.currentRevision;
  }

  feed(bytes: TerminalBytes): void {
    if (bytes.length === 0) {
      return;
    }

    const rows = this.currentSize.rows;
    this.dirtyStart = rows;
    this.dirtyEnd = -1;
    this.dirtyAll = !this.rowHints;
    this.scrolls = 0;
    this.regionTouched = false;
    this.modesTouched = false;
    this.invalidate = false;

    const regionWasFull =
      this.core.buffer.scrollTop === 0 && this.core.buffer.scrollBottom === rows - 1;

    this.parsed = false;
    this.terminal.input("", true);
    this.terminal.write(bytes, this.markParsed);

    if (!this.parsed) {
      throw new Error(
        "@xterm/headless parsed a chunk asynchronously; feed() requires synchronous parsing because a drained view is only valid until the next drain",
      );
    }

    this.currentRevision += 1;
    this.trackDamage(regionWasFull);
  }

  resize(size: GridSize): void {
    if (size.columns === this.currentSize.columns && size.rows === this.currentSize.rows) {
      return;
    }

    this.terminal.resize(size.columns, size.rows);
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };
    this.currentRevision += 1;
    this.shadow = new Uint32Array(
      this.currentSize.rows * this.currentSize.columns * WORDS_PER_CELL,
    );
    this.changedAt = new Float64Array(this.currentSize.rows);
    this.encoder.reserve(this.currentSize);
    this.fullFloor = this.currentRevision;
    this.resync();
  }

  repaintSince(revision: number): Uint8Array {
    const current = this.currentRevision;

    if (revision === current) {
      return EMPTY;
    }

    if (revision > current || revision < this.fullFloor || current - revision > SCROLL_RING) {
      return this.fullRepaint();
    }

    const { rows, columns } = this.currentSize;
    let scrolled = 0;

    for (let past = revision + 1; past <= current; past += 1) {
      scrolled += this.scrollAt[past % SCROLL_RING] ?? 0;
    }

    if (scrolled > rows) {
      scrolled = rows;
    }

    const modesChanged = this.modesChangedAt > revision;
    const cursorChanged = this.cursorChangedAt > revision;
    let anyRow = false;

    for (let y = 0; y < rows; y += 1) {
      if ((this.changedAt[y] ?? 0) > revision) {
        anyRow = true;
        break;
      }
    }

    if (!anyRow && !modesChanged && !cursorChanged && scrolled === 0) {
      return EMPTY;
    }

    const buffer = this.core.buffer;
    this.encoder.begin(this.modeState, modesChanged);

    if (scrolled > 0) {
      this.encoder.scrollUp(scrolled, rows);
    }

    for (let y = 0; y < rows; y += 1) {
      if ((this.changedAt[y] ?? 0) <= revision) {
        continue;
      }

      const line = buffer.lines.get(buffer.ybase + y);

      if (line === undefined) {
        continue;
      }

      this.encoder.paintRow(y, line, columns, this.cell);
    }

    const cursorRow = buffer.lines.get(buffer.ybase + buffer.y);
    this.encoder.cursor(
      cursorRow === undefined ? Math.min(buffer.x, columns - 1) : buffer.x,
      buffer.y,
      columns,
      cursorRow ?? NO_ROW,
      this.cell,
      this.modeState.origin ? buffer.scrollTop : 0,
    );

    return this.encoder.end() ?? this.fullRepaint();
  }

  fullRepaint(): Uint8Array {
    const size = `\x1b[8;${this.currentSize.rows};${this.currentSize.columns}t`;
    let trailer = this.cursorVisible ? "" : `\x1b[?${CURSOR_VISIBILITY_MODE}l`;

    if (this.mouseEncoding === "sgr") {
      trailer += `\x1b[?${SGR_MOUSE_MODE}h`;
    } else if (this.mouseEncoding === "sgrPixels") {
      trailer += `\x1b[?${SGR_PIXEL_MOUSE_MODE}h`;
    }

    if (this.cursorStyle !== DEFAULT_CURSOR_STYLE) {
      trailer += `\x1b[${this.cursorStyle} q`;
    }

    return encoder.encode(
      FULL_RESET + size + this.serializer.serialize({ scrollback: 0 }) + trailer,
    );
  }

  snapshotText(options: { readonly includeScrollback: boolean }): string {
    const buffer = this.terminal.buffer.active;
    const from = options.includeScrollback ? 0 : buffer.baseY;
    const lines: string[] = [];

    for (let y = from; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);

      if (line === undefined) {
        continue;
      }

      const text = line.translateToString(true);
      const previous = lines.length - 1;

      if (line.isWrapped && previous >= 0) {
        lines[previous] = `${lines[previous] ?? ""}${text}`;

        continue;
      }

      lines.push(text);
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  clearScrollback(): void {
    this.feed(CLEAR_SCROLLBACK);
  }

  dispose(): void {
    this.terminal.dispose();
    this.events = undefined;
  }

  private registerDamageListeners(): void {
    if (this.rowHints) {
      this.core._inputHandler.onRequestRefreshRows?.((range) => {
        if (range === undefined) {
          this.dirtyAll = true;

          return;
        }

        if (range.start < this.dirtyStart) {
          this.dirtyStart = range.start;
        }

        if (range.end > this.dirtyEnd) {
          this.dirtyEnd = range.end;
        }
      });
    }

    this.terminal.onScroll(() => {
      this.scrolls += 1;
    });
    this.terminal.buffer.onBufferChange(() => {
      this.invalidate = true;
    });

    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (parameters) => {
      this.trackPrivateModes(parameters, true);

      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (parameters) => {
      this.trackPrivateModes(parameters, false);

      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "h" }, () => {
      this.modesTouched = true;

      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "l" }, () => {
      this.modesTouched = true;

      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "r" }, () => {
      this.regionTouched = true;

      return false;
    });
    this.terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      this.modesTouched = true;
      this.cursorVisible = true;

      return false;
    });
    this.terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (parameters) => {
      const style = parameters[0];
      this.cursorStyle = Predicate.isNumber(style) ? style : DEFAULT_CURSOR_STYLE;
      this.modesTouched = true;

      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.invalidate = true;
      this.modesTouched = true;
      this.cursorVisible = true;
      this.mouseEncoding = "default";
      this.cursorStyle = DEFAULT_CURSOR_STYLE;

      return false;
    });
  }

  private trackPrivateModes(parameters: readonly (number | number[])[], set: boolean): void {
    this.modesTouched = true;

    for (const parameter of parameters) {
      const mode = Predicate.isNumber(parameter) ? parameter : parameter[0];

      if (mode === CURSOR_VISIBILITY_MODE) {
        this.cursorVisible = set;
      } else if (mode === SGR_MOUSE_MODE) {
        this.mouseEncoding = set ? "sgr" : "default";
      } else if (mode === SGR_PIXEL_MOUSE_MODE) {
        this.mouseEncoding = set ? "sgrPixels" : "default";
      }
    }
  }

  private trackDamage(regionWasFull: boolean): void {
    const revision = this.currentRevision;

    if (this.invalidate) {
      this.fullFloor = revision;
      this.resync();

      return;
    }

    const rows = this.currentSize.rows;
    const buffer = this.core.buffer;
    let scrolled = 0;

    if (this.scrolls > 0) {
      this.dirtyAll = true;

      const regionIsFull = buffer.scrollTop === 0 && buffer.scrollBottom === rows - 1;

      if (regionWasFull && regionIsFull && !this.regionTouched) {
        scrolled = Math.min(this.scrolls, rows);
      }
    }

    this.scrollAt[revision % SCROLL_RING] = scrolled;

    if (scrolled > 0) {
      const stride = this.currentSize.columns * WORDS_PER_CELL;
      this.shadow.copyWithin(0, scrolled * stride);
      this.changedAt.copyWithin(0, scrolled);
    }

    const from = this.dirtyAll ? 0 : Math.max(0, this.dirtyStart);
    const to = this.dirtyAll ? rows - 1 : Math.min(rows - 1, this.dirtyEnd);

    for (let y = from; y <= to; y += 1) {
      const line = buffer.lines.get(buffer.ybase + y);

      if (line === undefined) {
        this.blankRow(y);
        this.changedAt[y] = revision;

        continue;
      }

      const scrolledIn = y >= rows - scrolled;

      if (scrolledIn) {
        this.adoptRow(y, line);
        this.changedAt[y] = revision;

        continue;
      }

      if (this.syncRow(y, line)) {
        this.changedAt[y] = revision;
      }
    }

    if (buffer.x !== this.cursorX || buffer.y !== this.cursorY) {
      this.cursorX = buffer.x;
      this.cursorY = buffer.y;
      this.cursorChangedAt = revision;
    }

    if (this.modesTouched) {
      this.refreshModes();
      this.modesChangedAt = revision;
    }
  }

  private syncRow(y: number, line: InternalLine): boolean {
    const stride = this.currentSize.columns * WORDS_PER_CELL;
    const base = y * stride;
    const data = line._data;
    const words = Math.min(data.length, stride);
    let differs = false;

    for (let offset = 0; offset < words; offset += WORDS_PER_CELL) {
      const content = data[offset] ?? 0;

      if (
        (content & COMBINED_FLAG) !== 0 ||
        content !== this.shadow[base + offset] ||
        (data[offset + 1] ?? 0) !== this.shadow[base + offset + 1] ||
        (data[offset + 2] ?? 0) !== this.shadow[base + offset + 2]
      ) {
        differs = true;
        break;
      }
    }

    if (differs) {
      this.shadow.set(words === data.length ? data : data.subarray(0, words), base);
    }

    return differs;
  }

  private adoptRow(y: number, line: InternalLine): void {
    const stride = this.currentSize.columns * WORDS_PER_CELL;
    const data = line._data;
    const words = Math.min(data.length, stride);
    this.shadow.set(words === data.length ? data : data.subarray(0, words), y * stride);

    if (words < stride) {
      this.shadow.fill(0, y * stride + words, y * stride + stride);
    }
  }

  private blankRow(y: number): void {
    const stride = this.currentSize.columns * WORDS_PER_CELL;
    this.shadow.fill(0, y * stride, y * stride + stride);
  }

  private resync(): void {
    const revision = this.currentRevision;
    const rows = this.currentSize.rows;
    const buffer = this.core.buffer;

    for (let y = 0; y < rows; y += 1) {
      const line = buffer.lines.get(buffer.ybase + y);

      if (line === undefined) {
        this.blankRow(y);
      } else {
        this.adoptRow(y, line);
      }

      this.changedAt[y] = revision;
    }

    this.scrollAt[revision % SCROLL_RING] = 0;
    this.cursorX = buffer.x;
    this.cursorY = buffer.y;
    this.cursorChangedAt = revision;
    this.modesChangedAt = revision;
    this.refreshModes();
  }

  private refreshModes(): void {
    const modes = this.terminal.modes;
    const state = this.modeState;
    state.applicationCursorKeys = modes.applicationCursorKeysMode;
    state.applicationKeypad = modes.applicationKeypadMode;
    state.bracketedPaste = modes.bracketedPasteMode;
    state.insert = modes.insertMode;
    state.origin = modes.originMode;
    state.reverseWraparound = modes.reverseWraparoundMode;
    state.sendFocus = modes.sendFocusMode;
    state.wraparound = modes.wraparoundMode;
    state.mouseTracking = modes.mouseTrackingMode;
    state.cursorVisible = this.cursorVisible;
    state.mouseEncoding = this.mouseEncoding;
    state.cursorStyle = this.cursorStyle;
  }
}

export function createEmulator(options: {
  readonly size: GridSize;
  readonly scrollback: number;
}): TerminalEmulating {
  return new HeadlessEmulator(options.size, options.scrollback, { rowHints: true });
}
