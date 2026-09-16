import type { GridSize } from "@janela/core";
import type { IBufferCell } from "@xterm/headless";

export interface RowCells {
  readonly length: number;
  loadCell(x: number, cell: IBufferCell): void;
}

export interface LoadedCell extends IBufferCell {
  readonly content: number;
  readonly combinedData: string;
}

export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncoding = "default" | "sgr" | "sgrPixels";

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
  cursorStyle: number;
}

export const MAX_CELL_BYTES = 64;

export const ROW_OVERHEAD_BYTES = 32;

const FRAME_OVERHEAD_BYTES = 512;

const INITIAL_CAPACITY = 64 * 1024;

const COMBINED_FLAG = 0x20_00_00;

const COLOR_MODE_DEFAULT = 0;

const COLOR_MODE_RGB = 0x3_00_00_00;

const FIRST_BRIGHT_COLOR = 8;
const FIRST_PALETTE_COLOR = 16;
const FOREGROUND_BASE = 30;
const BRIGHT_FOREGROUND_BASE = 90;
const BACKGROUND_BASE = 40;
const BRIGHT_BACKGROUND_BASE = 100;

const MOUSE_TRACKING_MODES = {
  none: 0,
  x10: 9,
  vt200: 1000,
  drag: 1002,
  any: 1003,
} satisfies Record<MouseTracking, number>;

const ESCAPE = 0x1b;
const OPEN_BRACKET = 0x5b;
const SEMICOLON = 0x3b;
const QUESTION = 0x3f;
const SPACE = 0x20;
const ZERO = 0x30;
const ONE = 0x31;
const LINE_FEED = 0x0a;
const SET_MODE = 0x68;
const RESET_MODE = 0x6c;
const SGR_FINAL = 0x6d;
const CURSOR_POSITION = 0x48;
const CURSOR_FORWARD = 0x43;
const CURSOR_STYLE = 0x71;
const ERASE_CHARACTERS = 0x58;
const ERASE_IN_LINE = 0x4b;

export class RepaintEncoder {
  private bytes = new Uint8Array(0);
  private length = 0;
  private bound = 0;
  private overflowed = false;
  private wroteContent = false;

  private state: ModeState | undefined;

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

  private sgrOpen = false;
  private sgrEmpty = true;

  private readonly digits = new Uint8Array(10);

  get wrote(): boolean {
    return this.wroteContent;
  }

  reserve(size: GridSize): void {
    this.bound =
      size.rows * (size.columns * MAX_CELL_BYTES + ROW_OVERHEAD_BYTES) + FRAME_OVERHEAD_BYTES;
    this.bytes = new Uint8Array(Math.min(this.bound, INITIAL_CAPACITY));
    this.length = 0;
    this.overflowed = false;
  }

  begin(state: ModeState, emitModes: boolean): void {
    this.length = 0;
    this.overflowed = false;
    this.wroteContent = false;
    this.state = state;
    this.resetTrackedAttributes();
    this.write2(ESCAPE, OPEN_BRACKET);
    this.write2(ZERO, SGR_FINAL);

    if (emitModes) {
      this.writeModes(state);
      this.wroteContent = true;

      return;
    }

    this.neutraliseWriteModes(state);
  }

  scrollUp(lines: number, rows: number): void {
    if (this.overflowed || lines <= 0) {
      return;
    }

    this.writeCursorPosition(rows, 1);

    for (let index = 0; index < lines; index += 1) {
      this.write1(LINE_FEED);
    }

    this.wroteContent = true;
  }

  paintRow(y: number, row: RowCells, cols: number, cell: LoadedCell): void {
    if (this.overflowed) {
      return;
    }

    this.writeCursorPosition(y + 1, 1);
    this.wroteContent = true;

    let runLength = 0;
    let runBgMode = COLOR_MODE_DEFAULT;
    let runBgColor = 0;
    const cellCount = Math.min(cols, row.length);

    for (let x = 0; x < cellCount; x += 1) {
      row.loadCell(x, cell);

      const isSpacerAfterWideCharacter = cell.getWidth() === 0;

      if (isSpacerAfterWideCharacter) {
        continue;
      }

      if (cell.getCode() === 0) {
        const mode = cell.getBgColorMode();
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
      this.setBackground(runBgMode, runBgColor);
      this.write2(ESCAPE, OPEN_BRACKET);
      this.write1(ERASE_IN_LINE);
    }
  }

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

    const lastColumnIsWideCharacterSpacer = cell.getWidth() === 0;

    if (lastColumnIsWideCharacterSpacer) {
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
      this.write1(ONE);
      this.write1(ERASE_CHARACTERS);

      return;
    }

    this.writeCellAttributes(cell);
    this.writeCellCharacters(cell);
  }

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

  private writeModes(state: ModeState): void {
    this.writeMode(1, state.applicationCursorKeys, true);
    this.writeMode(66, state.applicationKeypad, true);
    this.writeMode(2004, state.bracketedPaste, true);
    this.writeMode(4, false, false);
    this.writeMode(6, false, true);
    this.writeMode(45, state.reverseWraparound, true);
    this.writeMode(1004, state.sendFocus, true);
    this.writeMode(7, state.wraparound, true);

    this.write2(ESCAPE, OPEN_BRACKET);
    this.write1(QUESTION);
    this.writeNumber(MOUSE_TRACKING_MODES.x10);
    this.write1(SEMICOLON);
    this.writeNumber(MOUSE_TRACKING_MODES.vt200);
    this.write1(SEMICOLON);
    this.writeNumber(MOUSE_TRACKING_MODES.drag);
    this.write1(SEMICOLON);
    this.writeNumber(MOUSE_TRACKING_MODES.any);
    this.write1(RESET_MODE);

    const tracking = MOUSE_TRACKING_MODES[state.mouseTracking];

    if (tracking !== MOUSE_TRACKING_MODES.none) {
      this.writeMode(tracking, true, true);
    }

    this.write2(ESCAPE, OPEN_BRACKET);
    this.write1(QUESTION);
    this.writeNumber(1006);
    this.write1(SEMICOLON);
    this.writeNumber(1016);
    this.write1(RESET_MODE);

    if (state.mouseEncoding === "sgr") {
      this.writeMode(1006, true, true);
    } else if (state.mouseEncoding === "sgrPixels") {
      this.writeMode(1016, true, true);
    }

    this.writeMode(25, state.cursorVisible, true);

    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(state.cursorStyle);
    this.write1(SPACE);
    this.write1(CURSOR_STYLE);
  }

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
    this.write1(set ? SET_MODE : RESET_MODE);
  }

  private eraseRun(length: number, bgMode: number, bgColor: number): void {
    this.setBackground(bgMode, bgColor);
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(length);
    this.write1(ERASE_CHARACTERS);
    this.write2(ESCAPE, OPEN_BRACKET);
    this.writeNumber(length);
    this.write1(CURSOR_FORWARD);
  }

  private setBackground(mode: number, color: number): void {
    if (mode === this.bgMode && color === this.bgColor) {
      return;
    }

    this.writeBackgroundParameters(mode, color);
    this.endSgr();
    this.bgMode = mode;
    this.bgColor = color;
  }

  private writeCellAttributes(cell: LoadedCell): void {
    if (cell.isAttributeDefault()) {
      if (this.isTrackedDefault()) {
        return;
      }

      this.write2(ESCAPE, OPEN_BRACKET);
      this.write2(ZERO, SGR_FINAL);
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
    const fgColor = fgMode === COLOR_MODE_DEFAULT ? 0 : cell.getFgColor();

    if (fgMode !== this.fgMode || fgColor !== this.fgColor) {
      if (cell.isFgDefault()) {
        this.sgrParameter(39);
      } else if (cell.isFgRGB()) {
        this.sgrParameter(38);
        this.sgrParameter(2);
        this.writeRgb(fgColor);
      } else if (fgColor < FIRST_BRIGHT_COLOR) {
        this.sgrParameter(FOREGROUND_BASE + fgColor);
      } else if (fgColor < FIRST_PALETTE_COLOR) {
        this.sgrParameter(BRIGHT_FOREGROUND_BASE + (fgColor - FIRST_BRIGHT_COLOR));
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

    if (color < FIRST_BRIGHT_COLOR) {
      this.sgrParameter(BACKGROUND_BASE + color);

      return;
    }

    if (color < FIRST_PALETTE_COLOR) {
      this.sgrParameter(BRIGHT_BACKGROUND_BASE + (color - FIRST_BRIGHT_COLOR));

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

    this.write1(SGR_FINAL);
    this.sgrOpen = false;
  }

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
    this.write1(CURSOR_POSITION);
  }

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
