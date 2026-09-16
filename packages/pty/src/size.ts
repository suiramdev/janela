export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = {
  columns: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};
