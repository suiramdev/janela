/**
 * `TerminalEmulating` over `@xterm/headless`.
 *
 * **The only module in the repository's daemon half that names an emulator
 * library**, which is the whole point of the seam it implements — see the
 * gated-modules table in `scripts/layers.ts`. Everything library-specific is
 * here; everything else in this package talks to `TerminalEmulating`.
 *
 * Damage tracking is the reason this file reaches past the public API. The
 * library knows which rows a chunk touched — it has to, to repaint a canvas — and
 * asking it is the difference between a delta and a screen. What it hands over is
 * a *conservative* range: its own tracker marks the whole scroll region on every
 * scroll and both cursor rows on every cursor move, so a tracker-only encoder
 * re-sends most of the screen when a TUI moves its cursor one cell. So the range
 * is a bound on where to look, and a shadow copy of the cells decides what
 * actually changed. Every internal is validated once, in the constructor, and a
 * version bump that moves one of them fails loudly instead of encoding nonsense.
 */

// oxlint-disable no-underscore-dangle -- `_core`, `_inputHandler` and `_data` are
// the library's own names. `libraryInternals` is where they are validated, and
// renaming them here would only hide which library member is meant.

import { hostname } from "node:os";

import type { GridSize } from "@janela/core";
import type { TerminalBytes } from "@janela/pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

import {
  parseNotification,
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

const encoder = new TextEncoder();

/**
 * Shared, never mutated. `repaintSince` is called once per frame per attached
 * client and "nothing changed" is the common answer; it must not allocate.
 */
const EMPTY = new Uint8Array(0);

/** `CSI 3 J` — erase scrollback, leaving the visible rows and the cursor alone. */
const CLEAR_SCROLLBACK = encoder.encode("\x1b[3J");

/**
 * `ESC c` (RIS), prefixed to every full repaint.
 *
 * `SerializeAddon` writes for a *fresh* terminal: relative cursor moves, `\r\n`
 * row separators, and mode sequences it only ever sets. Replayed onto a renderer
 * that already has content — the second repaint of any session — the result
 * diverges from the source. RIS rebuilds the receiver's buffers, returns it to
 * the normal screen and resets modes and attributes, which makes the replay
 * grid-, cursor-, buffer- and mode-identical. Verified by the round-trip test,
 * which fails on its second assertion without this.
 */
const FULL_RESET = "\x1bc";

/**
 * How many revisions of scroll history the emulator keeps.
 *
 * A delta that scrolls has to know how far the client's screen must move, which
 * is the sum of the scrolls since its revision. Keeping that per revision costs
 * one word each and bounds the memory (non-negotiable #9); a client further
 * behind than this gets a full repaint, which is what the frame loop owes a
 * stalled client anyway. 128 revisions is a second of continuous scrolling at
 * 120 Hz — a judgement value, and one to change only with a measurement.
 */
export const SCROLL_RING = 128;

/** Words per cell in a `BufferLine`'s packed data: content, foreground, background. */
const WORDS_PER_CELL = 3;

/**
 * `content & 0x200000` — the cell holds an *index* into the row's combined
 * character table rather than a codepoint. The string lives beside the row, so a
 * changed combined character does not change the packed word: a row holding one
 * is always treated as changed.
 */
const COMBINED_FLAG = 0x20_00_00;

/** A row of cells, plus the packed words the shadow grid diffs against. */
interface InternalLine extends RowCells {
  readonly _data: Uint32Array;
}

/** The library's active buffer. `_core.buffer` switches with the alternate screen. */
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
    onRequestRefreshRows?: (listener: (range: RefreshRange | undefined) => void) => unknown;
  };
}

/**
 * Everything reached for past the public API, checked once.
 *
 * A library bump that renames one of these must not turn into a silently wrong
 * grid — a shadow diff against a buffer that is no longer the active one, or a
 * combined character read from a field that stopped existing. So each assumption
 * is asserted here and the failure names what moved. `onRequestRefreshRows` is
 * the exception: without it the encoder diffs every row on every chunk, which is
 * slower and just as correct, so its absence degrades instead of throwing.
 */
function libraryInternals(terminal: Terminal): {
  readonly core: InternalCore;
  readonly cell: LoadedCell;
  readonly rowHints: boolean;
} {
  // The library's own type says nothing about `_core`, and no runtime check can
  // establish its shape for the compiler. Every field read off it below is
  // asserted instead, which is what this whole function is for.
  const internal = terminal as unknown as { readonly _core?: InternalCore };
  const core = internal._core;
  if (core === undefined || typeof core !== "object") {
    throw new Error("@xterm/headless internals changed: no _core");
  }
  const buffer = core.buffer;
  if (buffer === undefined || typeof buffer.lines?.get !== "function") {
    throw new Error("@xterm/headless internals changed: _core.buffer.lines.get");
  }
  if (typeof buffer.scrollTop !== "number" || typeof buffer.scrollBottom !== "number") {
    throw new Error("@xterm/headless internals changed: buffer scroll region");
  }
  const line = buffer.lines.get(0);
  if (line === undefined || !(line._data instanceof Uint32Array)) {
    throw new Error("@xterm/headless internals changed: BufferLine._data");
  }
  if (line._data.length !== terminal.cols * WORDS_PER_CELL) {
    throw new Error("@xterm/headless internals changed: BufferLine._data cell width");
  }
  if (typeof line.loadCell !== "function") {
    throw new Error("@xterm/headless internals changed: BufferLine.loadCell");
  }
  if (typeof buffer.getNullCell !== "function") {
    throw new Error("@xterm/headless internals changed: buffer.getNullCell");
  }
  const cell = buffer.getNullCell();
  if (typeof cell.content !== "number" || typeof cell.combinedData !== "string") {
    throw new Error("@xterm/headless internals changed: CellData content/combinedData");
  }
  return {
    core,
    cell,
    rowHints: typeof core._inputHandler?.onRequestRefreshRows === "function",
  };
}

/** A cursor row the library could not hand over. Never read: the cursor clamps instead. */
const NO_ROW: RowCells = {
  length: 0,
  loadCell: () => undefined,
};

export class HeadlessEmulator implements TerminalEmulating {
  /**
   * Package-internal, and deliberately not on `TerminalEmulating`: the round-trip
   * test reads the source grid through it to compare against a receiver. Nothing
   * outside this package can reach it, because `index.ts` exports the factory and
   * not the class.
   */
  readonly terminal: Terminal;

  events: TerminalEventSink | undefined;

  private readonly serializer = new SerializeAddon();
  /** Returned by the `size` getter as-is; replaced, never mutated, on resize. */
  private currentSize: GridSize;
  private currentRevision = 0;
  private parsed = false;
  /** One closure per emulator rather than one per frame. */
  private readonly markParsed = (): void => {
    this.parsed = true;
  };
  /** Read once. An OSC 7 handler must not call into the OS on the parse path. */
  private readonly hostName = hostname();

  private readonly core: InternalCore;
  /** One cell, loaded once per cell painted. The library's `CellData`. */
  private readonly cell: LoadedCell;
  /**
   * False when the library stopped handing over per-parse dirty rows, or when a
   * test asked for the fallback. Every chunk then diffs every row.
   */
  readonly rowHints: boolean;

  private readonly encoder = new RepaintEncoder();

  /** The cells the shadow grid last agreed with, row-major, `WORDS_PER_CELL` per cell. */
  private shadow: Uint32Array;
  /**
   * The revision at which row `y` last changed.
   *
   * Shifted with the rows on every screen scroll, so "the rows with
   * `changedAt[y] > n`" is exactly the set a client at revision `n` still needs
   * after it has scrolled its own screen by the scrolls since `n`. `Float64Array`
   * rather than `Uint32Array` because a daemon can outlive 2³² revisions and a
   * wrapped counter would answer "nothing changed".
   */
  private changedAt: Float64Array;
  /** Screen scrolls per revision, indexed `revision % SCROLL_RING`. */
  private readonly scrollAt = new Uint32Array(SCROLL_RING);

  /** The first revision a delta can be expressed from. Below it, a full repaint. */
  private fullFloor = 0;
  private cursorChangedAt = 0;
  private modesChangedAt = 0;
  private cursorX = 0;
  private cursorY = 0;

  /** One object, mutated in place: refreshed only when a mode sequence appeared. */
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
    cursorStyle: 0,
  };

  /** Tracked here because `terminal.modes` reports none of the three. */
  private cursorVisible = true;
  private mouseEncoding: MouseEncoding = "default";
  private cursorStyle = 0;

  /** Per-chunk damage, collected by the listeners during `write` and read after it. */
  private dirtyStart = 0;
  private dirtyEnd = -1;
  private dirtyAll = false;
  private scrolls = 0;
  private regionTouched = false;
  private modesTouched = false;
  private invalidate = false;

  constructor(size: GridSize, scrollback: number, options?: { readonly rowHints?: boolean }) {
    this.terminal = new Terminal({
      cols: size.columns,
      rows: size.rows,
      scrollback,
      // OSC 7, 9, 133 and 777 need `registerOscHandler`, which is proposed API.
      allowProposedApi: true,
      // The default is `info`, and it writes to `console`. A daemon parsing a
      // user's terminal output must not narrate it to the system log.
      logLevel: "off",
    });
    this.terminal.loadAddon(this.serializer);
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };

    const internals = libraryInternals(this.terminal);
    this.core = internals.core;
    this.cell = internals.cell;
    this.rowHints = internals.rowHints && options?.rowHints !== false;

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

    // Every handler is synchronous and returns `true`. Returning a promise would
    // suspend the parser, and `feed()` requires that a chunk is parsed before it
    // returns — see the note there.
    this.terminal.parser.registerOscHandler(7, (payload) => {
      const directory = parseWorkingDirectory(payload, this.hostName);
      if (directory !== undefined) {
        this.events?.onWorkingDirectory(directory);
      }
      return true;
    });
    this.terminal.parser.registerOscHandler(9, (payload) => {
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

    this.registerDamageListeners();
    this.resync();
  }

  /**
   * Everything that tells the encoder what a chunk did.
   *
   * The CSI and ESC handlers all return `false`, which is the documented way to
   * observe a sequence and still let the library act on it — a handler that
   * returned `true` would be *replacing* the implementation, and the grid would
   * stop matching the modes. They exist because three pieces of state the client
   * must mirror are not on `terminal.modes`: cursor visibility, mouse encoding
   * and cursor style.
   */
  private registerDamageListeners(): void {
    if (this.rowHints) {
      this.core._inputHandler.onRequestRefreshRows?.((range) => {
        // `undefined` is how the library says "the whole screen": an alternate
        // screen switch, or the end of a synchronised update.
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
    // SM/RM. Insert mode is the one that matters, and it is on `terminal.modes`,
    // so this only has to notice that *something* moved.
    this.terminal.parser.registerCsiHandler({ final: "h" }, () => {
      this.modesTouched = true;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "l" }, () => {
      this.modesTouched = true;
      return false;
    });
    // DECSTBM. A delta may only scroll the client's screen while the region is
    // the whole screen; a chunk that touched the region falls back to plain row
    // repaints, because our `\n` would scroll the client's region instead.
    this.terminal.parser.registerCsiHandler({ final: "r" }, () => {
      this.regionTouched = true;
      return false;
    });
    // DECSTR — a soft reset, which makes the cursor visible again.
    this.terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      this.modesTouched = true;
      this.cursorVisible = true;
      return false;
    });
    // DECSCUSR. Parameter 0 and an absent parameter both mean "the default",
    // which is what the client shows when it never saw the sequence.
    this.terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (parameters) => {
      const style = parameters[0];
      this.cursorStyle = typeof style === "number" ? style : 0;
      this.modesTouched = true;
      return false;
    });
    // RIS from the program itself. Everything is invalid, including the three
    // modes we track by hand.
    this.terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.invalidate = true;
      this.modesTouched = true;
      this.cursorVisible = true;
      this.mouseEncoding = "default";
      this.cursorStyle = 0;
      return false;
    });
  }

  private trackPrivateModes(parameters: readonly (number | number[])[], set: boolean): void {
    this.modesTouched = true;
    for (const parameter of parameters) {
      const mode = typeof parameter === "number" ? parameter : parameter[0];
      if (mode === 25) {
        this.cursorVisible = set;
      } else if (mode === 1006) {
        this.mouseEncoding = set ? "sgr" : "default";
      } else if (mode === 1016) {
        this.mouseEncoding = set ? "sgrPixels" : "default";
      }
    }
  }

  /**
   * Parses one drained chunk, synchronously.
   *
   * `TerminalBytes` is a view into a buffer the PTY layer reuses every frame, so
   * the bytes are gone by the next drain. `Terminal.write` is normally
   * *asynchronous* — it queues the chunk and parses it from a `setTimeout(0)` —
   * which would hand the parser someone else's output.
   *
   * The escape hatch is xterm's own: a write buffer that has just seen user input
   * parses the next chunk inline, so that a keystroke's echo is never a frame
   * late. `input("", true)` sets exactly that flag through the public API and
   * writes nothing. The flag is cleared by each inner write, so it is set per
   * chunk rather than once.
   *
   * The alternative — copying every chunk — is up to a megabyte of allocation per
   * terminal per frame, which is the throughput budget in docs/performance.md
   * spent on nothing. So the assumption is asserted instead of trusted: if a
   * future version of the library queues the write anyway, this throws rather
   * than silently parsing recycled memory.
   */
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
    // Read before the parse: a chunk that both scrolls and *then* sets a region
    // scrolled the whole screen, and one that sets a region first did not.
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
    // Every non-empty chunk bumps the revision, including one that only carried a
    // title: the daemon cannot know what a chunk did before it is parsed. A bump
    // with no damage behind it costs a client one length-zero answer.
    this.currentRevision += 1;
    this.trackDamage(regionWasFull);
  }

  /**
   * What the chunk changed, in rows.
   *
   * The order matters. A screen scroll moves the rows *and* their revisions, so
   * the shift happens before the diff; the rows that scrolled in are marked
   * changed whether or not their cells differ from what used to be there.
   */
  private trackDamage(regionWasFull: boolean): void {
    const revision = this.currentRevision;
    if (this.invalidate) {
      // An alternate-screen switch or a RIS. Nothing about the previous grid is
      // expressible as a delta, so every client behind this point is owed a full
      // repaint and the shadow starts again from what is on screen now.
      this.fullFloor = revision;
      this.resync();
      return;
    }

    const rows = this.currentSize.rows;
    const buffer = this.core.buffer;
    let scrolled = 0;
    if (this.scrolls > 0) {
      // The library's tracker marks the scroll region dirty, but the rows moved
      // under their revisions, so every row has to be re-diffed.
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
      if (y >= rows - scrolled) {
        // A row that scrolled in is new to the client whatever its cells say: the
        // client's own scroll moved something else into that position. Diffing it
        // could only ever answer "changed", so the shadow is copied and the
        // comparison skipped — which is the whole screen, every frame, under a
        // flood.
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

  /**
   * Diffs one row against the shadow copy and updates it. True when it changed.
   *
   * Word-wise rather than cell-wise through the public API: three integer
   * comparisons per cell, no allocation, and an early exit on the first
   * difference — this runs for every dirty row of every chunk.
   */
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

  /** Takes the row as-is, without asking whether it differs. */
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

  /** Adopts the whole screen as the shadow, and marks everything owed. */
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

  /**
   * Copies the library's modes into the state the encoder reads.
   *
   * `terminal.modes` builds an object per call, which is why this happens once
   * per chunk that carried a mode sequence rather than once per frame per client.
   */
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

  get size(): GridSize {
    return this.currentSize;
  }

  resize(size: GridSize): void {
    if (size.columns === this.currentSize.columns && size.rows === this.currentSize.rows) {
      return;
    }
    this.terminal.resize(size.columns, size.rows);
    // xterm clamps to 2×1. Report what it holds, not what was asked for, or the
    // negotiated PTY size and the grid quietly disagree.
    this.currentSize = { columns: this.terminal.cols, rows: this.terminal.rows };
    this.currentRevision += 1;
    this.shadow = new Uint32Array(
      this.currentSize.rows * this.currentSize.columns * WORDS_PER_CELL,
    );
    this.changedAt = new Float64Array(this.currentSize.rows);
    this.encoder.reserve(this.currentSize);
    // A reflow is not expressible as row repaints: the client's grid is the wrong
    // shape until it is told the new one, which only a full repaint carries.
    this.fullFloor = this.currentRevision;
    this.resync();
  }

  get revision(): number {
    return this.currentRevision;
  }

  /**
   * The damage encoder: the rows that changed since `revision`, and nothing else.
   *
   * Four cases answer with a full repaint instead, and each is a case where a
   * delta would be a guess: a client claiming a revision from the future, a
   * client older than the last alternate-screen switch, RIS or resize, a client
   * further behind than the scroll ring remembers, and a frame that did not fit
   * the encoder's bound. `fullRepaint` is always correct, so the optimisation can
   * only ever make us slower — never wrong.
   *
   * The returned view is into a buffer this emulator reuses, and is valid until
   * the next call that touches it. The frame loop copies it synchronously.
   */
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
      // The common answer for a chunk that carried a title, or a `CSI 3 J`.
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
      // Under origin mode `CUP` is relative to the scroll region's top row.
      this.modeState.origin ? buffer.scrollTop : 0,
    );
    return this.encoder.end() ?? this.fullRepaint();
  }

  /**
   * The visible screen, its dimensions, and only those.
   *
   * **`CSI 8 ; rows ; cols t` sits between the reset and the screen** (protocol
   * 5): the grid the daemon negotiated is the geometry this serialisation is
   * correct at, and a client painting it into a wider grid wraps every line at
   * the wrong column. It goes after RIS because RIS does not resize — verified
   * against `@xterm/xterm` 6.0.0 — and before the content for the obvious
   * reason. It reports `currentSize`, which is what xterm holds after its own
   * clamp, so the report and the PTY can never disagree.
   *
   * A receiver acts on it only with `windowOptions.setWinSizeChars` enabled: the
   * library gates parameter 8 on that flag and then implements no case for it,
   * so the client supplies the resize itself. `packages/terminal-ui`'s
   * `xtermRendering` is that client; the round-trip test's receiver mirrors it.
   *
   * The three modes the serialiser does not emit are appended after it: cursor
   * visibility, mouse encoding and cursor style. Without them a client that
   * reattaches to a `vim` session shows a cursor `vim` hid, and one that
   * reattaches to a mouse-driven TUI reports coordinates in an encoding the
   * program did not ask for.
   *
   * Scrollback is not part of attaching: serialising 10 000 lines costs 24 ms and
   * 662 KB against a 50 ms attach budget, for history a client can neither scroll
   * nor search yet. A reattaching client starts with an empty scrollback, as
   * tmux's does.
   *
   * It stays allocating: this runs on attach and resize, not per frame.
   */
  fullRepaint(): Uint8Array {
    const size = `\x1b[8;${this.currentSize.rows};${this.currentSize.columns}t`;
    let trailer = this.cursorVisible ? "" : "\x1b[?25l";
    if (this.mouseEncoding === "sgr") {
      trailer += "\x1b[?1006h";
    } else if (this.mouseEncoding === "sgrPixels") {
      trailer += "\x1b[?1016h";
    }
    if (this.cursorStyle !== 0) {
      trailer += `\x1b[${this.cursorStyle} q`;
    }
    return encoder.encode(
      FULL_RESET + size + this.serializer.serialize({ scrollback: 0 }) + trailer,
    );
  }

  /**
   * Plain text, with wrapped lines rejoined so a long line comes back whole.
   *
   * On the alternate screen `includeScrollback` adds nothing: that buffer has no
   * history, and the normal buffer's is not what is on screen.
   */
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

  /**
   * Drops history through the parser rather than around it.
   *
   * Going through `feed` keeps this in band with whatever output is already
   * queued, and bumps the revision — a mirror that is not told the buffer changed
   * keeps rendering a scrollback the daemon no longer has. The visible rows do
   * not move, so the delta a client gets is length zero.
   *
   * Known limit: on the alternate screen this trims the alternate buffer, which
   * has no history, and the normal buffer keeps its own until the program exits.
   * That matches what `CSI 3 J` means, and clearing a buffer the user cannot
   * currently see would be the surprising choice.
   */
  clearScrollback(): void {
    this.feed(CLEAR_SCROLLBACK);
  }

  dispose(): void {
    // Disposes the serialise addon too, through the addon manager.
    this.terminal.dispose();
    this.events = undefined;
  }
}

/**
 * Builds the production emulator.
 *
 * `scrollback` is bounded by the caller passing `DEFAULT_SCROLLBACK` rather than
 * being optional here, because an unbounded ring buffer is the most obvious way
 * to violate non-negotiable #9 and a default that hides it helps nobody.
 */
export function createEmulator(options: {
  readonly size: GridSize;
  readonly scrollback: number;
}): TerminalEmulating {
  return new HeadlessEmulator(options.size, options.scrollback);
}
