/**
 * The bytes half of the damage encoder: rows and cursor in, escape sequences out.
 *
 * Split from `HeadlessEmulator` because the two halves fail differently. Damage
 * tracking is a question about the library's internals; this is a question about
 * VT semantics, and it is testable by reading the bytes it wrote.
 *
 * **Nothing here allocates after `reserve()`.** Everything is written into one
 * buffer that is reused for every frame of the emulator's life, and the numbers
 * and characters are written byte by byte rather than through `String(n)` or a
 * `TextEncoder`. That is not premature: this runs once per frame per attached
 * client, which is 360 times a second at the scale target in docs/performance.md,
 * and the returned view is copied by the frame loop before the next call.
 *
 * Three VT details drive the shape of the output, and each one is a bug we would
 * otherwise ship:
 *
 * - **Erased cells are not spaces.** A cell erased under `CSI 44 m` carries the
 *   background colour, and a client that received `CSI 3 C` (cursor forward) over
 *   it would keep whatever it had there. So a run of empty cells is always
 *   *erased* — background set, `CSI n X`, then `CSI n C` — and the row's tail is
 *   always an `EL`. `SerializeAddon` may skip that because it writes for a fresh
 *   receiver; a delta has no such luxury.
 * - **Insert mode and origin mode change what our own writes mean.** With `IRM`
 *   set, printing a row shifts the rest of it right; with `DECOM` set, `CUP` is
 *   relative to the scroll region. Both are neutralised before anything is
 *   painted and restored by `cursor()`, which is why that call is mandatory and
 *   last.
 * - **A cursor at column `cols` is a real state** (pending wrap), and neither
 *   `CUP` nor `CUF` can reach it: both clamp. The only way there is to print in
 *   the last column, so that is what `cursor()` does.
 */

import type { GridSize } from "@janela/core";
import type { IBufferCell } from "@xterm/headless";

/**
 * A row whose cells can be loaded into a reused cell object. The library's
 * `BufferLine` satisfies it; the interface exists so this module needs no
 * internal type from the library.
 */
export interface RowCells {
  readonly length: number;
  loadCell(x: number, cell: IBufferCell): unknown;
}

/**
 * The library's `CellData` — `buffer.getNullCell()` — which carries the two
 * fields the public `IBufferCell` omits. `content` is the packed word: the
 * combined-character flag lives there and nowhere else. `combinedData` is only
 * meaningful when that flag is set; the field keeps its previous value otherwise.
 */
export interface LoadedCell extends IBufferCell {
  readonly content: number;
  readonly combinedData: string;
}

export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncoding = "default" | "sgr" | "sgrPixels";

/**
 * Everything a client must mirror that is not a cell.
 *
 * One object per emulator, mutated in place: a client's mode state is refreshed
 * at most once per frame and only when something changed it, so allocating a
 * snapshot would be an allocation per frame for nothing.
 */
export interface ModeState {
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  insert: boolean;
  origin: boolean;
  reverseWraparound: boolean;
  sendFocus: boolean;
  wraparound: boolean;
  mouseTracking: MouseTracking;
  mouseEncoding: MouseEncoding;
  cursorVisible: boolean;
  /** DECSCUSR parameter. 0 is "whatever the client's default is". */
  cursorStyle: number;
}

/**
 * Worst case one cell can cost: truecolor foreground and background, every flag
 * turned on, and a four-byte codepoint — 62 bytes, measured against the longest
 * sequence `writeCellAttributes` can emit.
 */
export const MAX_CELL_BYTES = 64;

/** Per-row overhead: `CUP`, a trailing `EL`, and one interior `ECH`/`CUF` pair. */
export const ROW_OVERHEAD_BYTES = 32;

/**
 * Room for the mode line, the scroll, the cursor and the reset prefix, once per
 * frame rather than per row.
 */
const FRAME_OVERHEAD_BYTES = 512;

/** The initial allocation. A 200×60 grid's bound is 800 KB, which nobody needs up front. */
const INITIAL_CAPACITY = 64 * 1024;

/** `content & 0x200000` — the cell holds an index into the row's combined-character table. */
const COMBINED_FLAG = 0x20_00_00;

/** Colour modes, as `getFgColorMode()` reports them (`common/buffer/Constants.ts`). */
const COLOR_MODE_DEFAULT = 0;

const ESCAPE = 0x1b;
const OPEN_BRACKET = 0x5b; // [
const SEMICOLON = 0x3b;
const QUESTION = 0x3f;
const SPACE = 0x20;
const LOWER_M = 0x6d; // m
const ZERO = 0x30;

export class RepaintEncoder {
  /** The frame buffer. Replaced at most twice per grid size: `reserve`, then one `grow`. */
  private bytes = new Uint8Array(0);
  private length = 0;
  /** The provable upper bound for the current grid. `grow()` never goes past it. */
  private bound = 0;
  private overflowed = false;
  private wroteContent = false;

  /** The mode state `begin()` was handed. Read again by `cursor()` to restore it. */
  private state: ModeState | undefined;

  /** Tracked SGR, so a run of like-attributed cells costs one sequence. */
  private fgMode = COLOR_MODE_DEFAULT;
  private fgColor = 0;
  private bgMode = COLOR_MODE_DEFAULT;
  private bgColor = 0;
  private bold = false;
  private dim = false;
  private italic = false;
  private underline = false;
  private blink = false;
  private inverse = false;
  private invisible = false;
  private strikethrough = false;
  private overline = false;

  /** Set while a `CSI …m` is open, so parameters know whether they need a `;`. */
  private sgrOpen = false;
  private sgrEmpty = true;

  /** Scratch for the decimal writer. One per encoder, never grown. */
  private readonly digits = new Uint8Array(10);

  /** True once a row, a scroll or a mode line was written — the reset prefix does not count. */
  get wrote(): boolean {
    return this.wroteContent;
  }

  /**
   * Sizes the buffer for a grid. Called on construction and on every resize.
   *
   * The bound is what makes overflow a programming error rather than a
   * possibility: past it, `end()` returns `undefined` and the caller answers with
   * a full repaint instead of a truncated delta.
   */
  reserve(size: GridSize): void {
    this.bound =
      size.rows * (size.columns * MAX_CELL_BYTES + ROW_OVERHEAD_BYTES) + FRAME_OVERHEAD_BYTES;
    this.bytes = new Uint8Array(Math.min(this.bound, INITIAL_CAPACITY));
    this.length = 0;
    this.overflowed = false;
  }

  /**
   * Starts a frame.
   *
   * `CSI 0 m` first: the tracked attribute state is per frame, and a client that
   * held bold from its last delta must not paint this one bold.
   *
   * `emitModes` is the caller's decision — it knows whether anything changed the
   * modes since the client's revision. Either way insert and origin mode end up
   * off for the duration of the frame, because both change what a `CUP` and a
   * printed character mean. `cursor()` puts them back.
   */
  begin(state: ModeState, emitModes: boolean): void {
    this.length = 0;
    this.overflowed = false;
    this.wroteContent = false;
    this.state = state;
    this.resetTrackedAttributes();
    this.write2(ESCAPE, OPEN_BRACKET);
    this.write2(ZERO, LOWER_M);
    if (emitModes) {
      this.writeModes(state);
      this.wroteContent = true;
      return;
    }
    this.neutraliseWriteModes(state);
  }

  /**
   * Scrolls the client's screen up by `lines`, so its scrollback receives what
   * ours did.
   *
   * `CUP` to the last row and then that many line feeds: the only sequence that
   * both scrolls and *keeps* the lines that leave the screen. `CSI S` (SU)
   * discards them, and a client that lost them has a scrollback the daemon's
   * disagrees with. Only correct while the scroll region is the whole screen,
   * which is the caller's guard, not this one's.
   */
  scrollUp(lines: number, rows: number): void {
    if (this.overflowed || lines <= 0) {
      return;
    }
    this.writeCursorPosition(rows, 1);
    for (let index = 0; index < lines; index += 1) {
      this.write1(0x0a);
    }
    this.wroteContent = true;
  }

  /** Repaints one viewport row, whole. `cell` is reused for every cell in it. */
  paintRow(y: number, row: RowCells, cols: number, cell: LoadedCell): void {
    if (this.overflowed) {
      return;
    }
    this.writeCursorPosition(y + 1, 1);
    this.wroteContent = true;

    let runLength = 0;
    let runBgMode = COLOR_MODE_DEFAULT;
    let runBgColor = 0;
    const width = Math.min(cols, row.length);
    for (let x = 0; x < width; x += 1) {
      row.loadCell(x, cell);
      const cellWidth = cell.getWidth();
      if (cellWidth === 0) {
        // The spacer the library keeps after a wide character. It holds no
        // content of its own, and printing anything for it would overwrite the
        // wide character's second column.
        continue;
      }
      if (cell.getCode() === 0) {
        const mode = cell.getBgColorMode();
        // A default-background cell reports colour −1; normalising it to 0 keeps
        // the tracked state comparable with what `CSI 49 m` leaves behind, so a
        // row of untouched cells emits no colour sequence at all.
        const color = mode === COLOR_MODE_DEFAULT ? 0 : cell.getBgColor();
        if (runLength > 0 && (mode !== runBgMode || color !== runBgColor)) {
          this.eraseRun(runLength, runBgMode, runBgColor);
          runLength = 0;
        }
        runBgMode = mode;
        runBgColor = color;
        runLength += 1;
        continue;
      }
      if (runLength > 0) {
        this.eraseRun(runLength, runBgMode, runBgColor);
        runLength = 0;
      }
      this.writeCellAttributes(cell);
      this.writeCellCharacters(cell);
    }
    if (runLength > 0) {
      // The tail. `EL` rather than `ECH` because the client may hold content past
      // the row's last written cell — a shorter line overwriting a longer one is
      // the common case, and `ECH` of the run alone would leave the remainder.
      this.setBackground(runBgMode, runBgColor);
      this.write2(ESCAPE, OPEN_BRACKET);
      this.write1(0x4b); // K
    }
  }

  /**
   * Places the cursor, and restores the modes `begin()` neutralised. **Must be
   * the last call of a frame**, because `CSI ? 6 h` homes the cursor.
   *
   * `rowOffset` is the scroll region's top row when origin mode is on, because
   * `CUP` is relative to it then; zero otherwise.
   *
   * `x === cols` is the pending-wrap state, which `CUP` clamps out of and `CUF`
   * cannot reach: the cursor sits past the last column and the next printed
   * character wraps. The only way to reproduce it is to print in the last column,
   * so the cell there is rewritten — or, if it is empty, a space is printed and
   * then erased with `CSI 1 X`, which leaves the cell as it was and the cursor
   * where it must be.
   */
  cursor(x: number, y: number, cols: number, row: RowCells, cell: LoadedCell, rowOffset = 0): void {
    if (this.overflowed) {
      return;
    }
    const state = this.state;
    if (state !== undefined) {
      if (state.insert) {
        this.writeMode(4, true, false);
      }
      if (state.origin) {
        this.writeMode(6, true, true);
      }
    }

    const line = Math.max(1, y + 1 - rowOffset);
    if (x < cols) {
      this.writeCursorPosition(line, x + 1);
      return;
    }
    row.loadCell(cols - 1, cell);
    if (cell.getWidth() === 0) {
      // The last column is the second half of a wide character. Printing there
      // would erase it; the character has to be printed whole from the column
      // before, which lands the cursor past the last column just the same.
      row.loadCell(cols - 2, cell);
      this.writeCursorPosition(line, cols - 1);
      this.writeCellAttributes(cell);
      this.writeCellCharacters(cell);
      return;
    }
    this.writeCursorPosition(line, cols);
    if (cell.getCode() === 0) {
      const mode = cell.getBgColorMode();
      this.setBackground(mode, mode === COLOR_MODE_DEFAULT ? 0 : cell.getBgColor());
      this.write1(SPACE);
      this.write2(ESCAPE, OPEN_BRACKET);
      this.write1(0x31); // 1
      this.write1(0x58); // X
      return;
    }
    this.writeCellAttributes(cell);
    this.writeCellCharacters(cell);
  }

  /**
   * The frame, as a view into the shared buffer — valid until the next `begin()`.
   *
   * `undefined` means the frame did not fit in the bound, which the caller answers
   * with a full repaint. A truncated delta is the one thing worse than a slow one.
   */
  end(): Uint8Array | undefined {
    if (this.overflowed) {
      return undefined;
    }
    return this.bytes.subarray(0, this.length);
  }

  private resetTrackedAttributes(): void {
    this.fgMode = COLOR_MODE_DEFAULT;
    this.fgColor = 0;
    this.bgMode = COLOR_MODE_DEFAULT;
    this.bgColor = 0;
    this.bold = false;
    this.dim = false;
    this.italic = false;
    this.underline = false;
    this.blink = false;
    this.inverse = false;
    this.invisible = false;
    this.strikethrough = false;
    this.overline = false;
  }

  /**
   * The full mode line: **both polarities, always**.
   *
   * A delta arrives at a client whose modes are whatever its last delta left, and
   * a client that once entered bracketed-paste mode has to be told it is over.
   * `SerializeAddon` only ever *sets* modes, which is why replaying it needs a
   * `RIS` in front and a delta cannot use it.
   *
   * Insert and origin are written *off* here whatever the state says; `cursor()`
   * restores them once nothing else will be painted.
   */
  private writeModes(state: ModeState): void {
    this.writeMode(1, state.applicationCursorKeys, true);
    this.writeMode(66, state.applicationKeypad, true);
    this.writeMode(2004, state.bracketedPaste, true);
    this.writeMode(4, false, false);
    this.writeMode(6, false, true);
    this.writeMode(45, state.reverseWraparound, true);
    this.writeMode(1004, state.sendFocus, true);
    this.writeMode(7, state.wraparound, true);

    // Mouse tracking is one of four exclusive modes, and a client may hold any of
    // them: clear all four, then set the one that is on.
    this.write2(ESCAPE, OPEN_BRACKET);
    this.write1(QUESTION);
    this.writeNumber(9);
    this.write1(SEMICOLON);
    this.writeNumber(1000);
    this.write1(SEMICOLON);
    this.writeNumber(1002);
    this.write1(SEMICOLON);
    this.writeNumber(1003);
    this.write1(0x6c); // l
    const tracking = MOUSE_TRACKING_MODES[state.mouseTracking];
    if (tracking !== 0) {
      this.writeMode(tracking, true, true);
    }

    // Mouse encoding likewise. `SerializeAddon` emits neither of these, which is
    // the second reason a full repaint is not a delta: a client left in SGR
    // encoding reports coordinates the daemon cannot parse.
    this.write2(ESCAPE, OPEN_BRACKET);
    this.write1(QUESTION);
    this.writeNumber(1006);
    this.write1(SEMICOLON);
    this.writeNumber(1016);
    this.write1(0x6c); // l
    if (state.mouseEncoding === "sgr") {
      this.writeMode(1006, true, true);
    } else if (state.mouseEncoding === "sgrPixels") {
      this.writeMode(1016, true, true);
    }

    this.writeMode(25, state.cursorVisible, true);

    // DECSCUSR. Parameter 0 means "the client's default", which is what an
    // emulator that never saw the sequence is showing.
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(state.cursorStyle);
    this.write1(SPACE);
    this.write1(0x71); // q
  }

  /** Just the two modes that change what our own bytes mean, when they are on. */
  private neutraliseWriteModes(state: ModeState): void {
    if (state.insert) {
      this.writeMode(4, false, false);
    }
    if (state.origin) {
      this.writeMode(6, false, true);
    }
  }

  private writeMode(mode: number, set: boolean, dec: boolean): void {
    this.write2(ESCAPE, OPEN_BRACKET);
    if (dec) {
      this.write1(QUESTION);
    }
    this.writeNumber(mode);
    this.write1(set ? 0x68 : 0x6c); // h : l
  }

  /**
   * Erases a run of empty cells and steps over it.
   *
   * `ECH` before `CUF`, never `CUF` alone: the cells carry a background colour
   * and the client may hold characters there. `ECH` fills with the *current*
   * background, so the background is set first — and left set, because the next
   * cell's attribute diff accounts for it.
   */
  private eraseRun(length: number, bgMode: number, bgColor: number): void {
    this.setBackground(bgMode, bgColor);
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(length);
    this.write1(0x58); // X
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(length);
    this.write1(0x43); // C
  }

  /** Sets the background alone, for an erase. Foreground and flags are irrelevant to `ECH`. */
  private setBackground(mode: number, color: number): void {
    if (mode === this.bgMode && color === this.bgColor) {
      return;
    }
    this.writeBackgroundParameters(mode, color);
    this.endSgr();
    this.bgMode = mode;
    this.bgColor = color;
  }

  /**
   * The attribute diff for one cell.
   *
   * `22` turns off bold *and* dim in every terminal, so wanting one of the two
   * while the other is on means `22` and then the one that is wanted. Emitting
   * `22` for either — which `SerializeAddon` does — silently drops the other.
   *
   * Extended attributes (underline style and colour, hyperlinks) are not
   * reproduced. That is parity with `fullRepaint`, whose serialiser does not
   * emit them either, and not a gap this encoder introduces.
   */
  private writeCellAttributes(cell: LoadedCell): void {
    if (cell.isAttributeDefault()) {
      if (this.isTrackedDefault()) {
        return;
      }
      this.write2(ESCAPE, OPEN_BRACKET);
      this.write2(ZERO, LOWER_M);
      this.resetTrackedAttributes();
      return;
    }

    const wantBold = cell.isBold() !== 0;
    const wantDim = cell.isDim() !== 0;
    if ((this.bold && !wantBold) || (this.dim && !wantDim)) {
      this.sgrParameter(22);
      this.bold = false;
      this.dim = false;
    }
    if (wantBold && !this.bold) {
      this.sgrParameter(1);
      this.bold = true;
    }
    if (wantDim && !this.dim) {
      this.sgrParameter(2);
      this.dim = true;
    }

    const wantItalic = cell.isItalic() !== 0;
    if (wantItalic !== this.italic) {
      this.sgrParameter(wantItalic ? 3 : 23);
      this.italic = wantItalic;
    }
    const wantUnderline = cell.isUnderline() !== 0;
    if (wantUnderline !== this.underline) {
      this.sgrParameter(wantUnderline ? 4 : 24);
      this.underline = wantUnderline;
    }
    const wantBlink = cell.isBlink() !== 0;
    if (wantBlink !== this.blink) {
      this.sgrParameter(wantBlink ? 5 : 25);
      this.blink = wantBlink;
    }
    const wantInverse = cell.isInverse() !== 0;
    if (wantInverse !== this.inverse) {
      this.sgrParameter(wantInverse ? 7 : 27);
      this.inverse = wantInverse;
    }
    const wantInvisible = cell.isInvisible() !== 0;
    if (wantInvisible !== this.invisible) {
      this.sgrParameter(wantInvisible ? 8 : 28);
      this.invisible = wantInvisible;
    }
    const wantStrikethrough = cell.isStrikethrough() !== 0;
    if (wantStrikethrough !== this.strikethrough) {
      this.sgrParameter(wantStrikethrough ? 9 : 29);
      this.strikethrough = wantStrikethrough;
    }
    const wantOverline = cell.isOverline() !== 0;
    if (wantOverline !== this.overline) {
      this.sgrParameter(wantOverline ? 53 : 55);
      this.overline = wantOverline;
    }

    const fgMode = cell.getFgColorMode();
    // Default cells report colour −1; see the note in `paintRow`.
    const fgColor = fgMode === COLOR_MODE_DEFAULT ? 0 : cell.getFgColor();
    if (fgMode !== this.fgMode || fgColor !== this.fgColor) {
      if (cell.isFgDefault()) {
        this.sgrParameter(39);
      } else if (cell.isFgRGB()) {
        this.sgrParameter(38);
        this.sgrParameter(2);
        this.writeRgb(fgColor);
      } else if (fgColor < 8) {
        this.sgrParameter(30 + fgColor);
      } else if (fgColor < 16) {
        this.sgrParameter(82 + fgColor); // 90 + (colour - 8)
      } else {
        this.sgrParameter(38);
        this.sgrParameter(5);
        this.sgrParameter(fgColor);
      }
      this.fgMode = fgMode;
      this.fgColor = fgColor;
    }

    const bgMode = cell.getBgColorMode();
    const bgColor = bgMode === COLOR_MODE_DEFAULT ? 0 : cell.getBgColor();
    if (bgMode !== this.bgMode || bgColor !== this.bgColor) {
      this.writeBackgroundParameters(bgMode, bgColor);
      this.bgMode = bgMode;
      this.bgColor = bgColor;
    }
    this.endSgr();
  }

  private writeBackgroundParameters(mode: number, color: number): void {
    if (mode === COLOR_MODE_DEFAULT) {
      this.sgrParameter(49);
      return;
    }
    if (mode === COLOR_MODE_RGB) {
      this.sgrParameter(48);
      this.sgrParameter(2);
      this.writeRgb(color);
      return;
    }
    if (color < 8) {
      this.sgrParameter(40 + color);
      return;
    }
    if (color < 16) {
      this.sgrParameter(92 + color); // 100 + (colour - 8)
      return;
    }
    this.sgrParameter(48);
    this.sgrParameter(5);
    this.sgrParameter(color);
  }

  private writeRgb(color: number): void {
    this.sgrParameter((color >> 16) & 0xff);
    this.sgrParameter((color >> 8) & 0xff);
    this.sgrParameter(color & 0xff);
  }

  private isTrackedDefault(): boolean {
    return (
      this.fgMode === COLOR_MODE_DEFAULT &&
      this.bgMode === COLOR_MODE_DEFAULT &&
      !this.bold &&
      !this.dim &&
      !this.italic &&
      !this.underline &&
      !this.blink &&
      !this.inverse &&
      !this.invisible &&
      !this.strikethrough &&
      !this.overline
    );
  }

  private sgrParameter(value: number): void {
    if (!this.sgrOpen) {
      this.write2(ESCAPE, OPEN_BRACKET);
      this.sgrOpen = true;
      this.sgrEmpty = true;
    }
    if (!this.sgrEmpty) {
      this.write1(SEMICOLON);
    }
    this.sgrEmpty = false;
    this.writeNumber(value);
  }

  private endSgr(): void {
    if (!this.sgrOpen) {
      return;
    }
    this.write1(LOWER_M);
    this.sgrOpen = false;
  }

  /**
   * The cell's characters, as UTF-8.
   *
   * A combined cell — a base plus its accents, or an emoji sequence — keeps its
   * *index* in `content` and the string in the row's table, so the string is read
   * through `combinedData` and encoded from its UTF-16 units. Anything else is
   * one codepoint, which is the common case and never touches a string.
   */
  private writeCellCharacters(cell: LoadedCell): void {
    if ((cell.content & COMBINED_FLAG) !== 0) {
      this.writeUtf16(cell.combinedData);
      return;
    }
    this.writeCodePoint(cell.getCode());
  }

  private writeUtf16(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd8_00 && unit <= 0xdb_ff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1);
        if (low >= 0xdc_00 && low <= 0xdf_ff) {
          this.writeCodePoint((unit - 0xd8_00) * 0x4_00 + (low - 0xdc_00) + 0x1_00_00);
          index += 1;
          continue;
        }
      }
      this.writeCodePoint(unit);
    }
  }

  private writeCodePoint(code: number): void {
    if (code < 0x80) {
      this.write1(code);
      return;
    }
    if (code < 0x8_00) {
      this.write2(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      return;
    }
    if (code < 0x1_00_00) {
      this.write2(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f));
      this.write1(0x80 | (code & 0x3f));
      return;
    }
    this.write2(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f));
    this.write2(0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }

  private writeCursorPosition(row: number, column: number): void {
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(row);
    this.write1(SEMICOLON);
    this.writeNumber(column);
    this.write1(0x48); // H
  }

  /** Decimal, without `String(n)` — this runs several times per cell. */
  private writeNumber(value: number): void {
    if (value < 10) {
      this.write1(ZERO + value);
      return;
    }
    let remaining = value;
    let count = 0;
    while (remaining > 0) {
      this.digits[count] = ZERO + (remaining % 10);
      remaining = Math.floor(remaining / 10);
      count += 1;
    }
    if (!this.reserveBytes(count)) {
      return;
    }
    for (let index = count - 1; index >= 0; index -= 1) {
      this.bytes[this.length] = this.digits[index] ?? ZERO;
      this.length += 1;
    }
  }

  private write1(byte: number): void {
    if (!this.reserveBytes(1)) {
      return;
    }
    this.bytes[this.length] = byte;
    this.length += 1;
  }

  private write2(first: number, second: number): void {
    if (!this.reserveBytes(2)) {
      return;
    }
    this.bytes[this.length] = first;
    this.bytes[this.length + 1] = second;
    this.length += 2;
  }

  /**
   * Makes room, growing once to the bound if the initial allocation was smaller.
   *
   * Past the bound the frame is abandoned rather than truncated: `end()` answers
   * `undefined` and the caller sends a full repaint. The bound is computed from
   * the grid and the per-cell worst case, so reaching it means one of those two
   * is wrong — which is a bug to find, not a stream to corrupt.
   */
  private reserveBytes(count: number): boolean {
    if (this.overflowed) {
      return false;
    }
    if (this.length + count <= this.bytes.length) {
      return true;
    }
    if (this.bytes.length >= this.bound) {
      this.overflowed = true;
      return false;
    }
    const grown = new Uint8Array(this.bound);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    return this.length + count <= grown.length;
  }
}

/** `getFgColorMode()`/`getBgColorMode()` for a truecolor cell (`Attributes.CM_RGB`). */
const COLOR_MODE_RGB = 0x3_00_00_00;

/** DECSET numbers for the four mouse-tracking modes; 0 for none. */
const MOUSE_TRACKING_MODES: Readonly<Record<MouseTracking, number>> = {
  none: 0,
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003,
};
