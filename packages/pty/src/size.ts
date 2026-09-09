/**
 * Terminal dimensions, in cells and pixels.
 *
 * Pixels matter: without them, programs that draw images (kitty graphics, sixel)
 * and some TUI layout code get it wrong. `TIOCSWINSZ` carries both, so we always
 * send both.
 *
 * The honest edge, unchanged by the migration: pixel metrics are a *client*
 * fact and the daemon is what sets the window size. Two clients on displays with
 * different backing scales make this genuinely ambiguous, and the protocol's
 * minimum-viewport rule sizes the grid in cells, not pixels.
 */
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
