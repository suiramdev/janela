import type { GridSize } from "@janela/core";

/**
 * The client half of the terminal seam: something that draws.
 *
 * ## Two seams, and now two libraries
 *
 * `@janela/terminal` (daemon) owns `TerminalEmulating` — the authoritative grid and
 * the repaint encoder. This owns `TerminalRendering` — fonts, painting, selection,
 * keyboard. **Only these two packages may name a terminal library**, and the rule is
 * enforced by `scripts/layers.ts` rather than by review.
 *
 * What changed: they are no longer the same library on both sides. The daemon runs a
 * headless emulator, the client runs a renderer, and they are separate packages from
 * the same family. That is possible only because the protocol ships escape sequences
 * rather than grids.
 *
 * ## Why a renderer can stay this simple
 *
 * It is fed **escape sequences**, exactly as a real terminal is fed them from a pty.
 * The daemon has already done the hard part: it holds the grid, tracks damage, and
 * emits the shortest sequence that repaints what changed. So this type needs no
 * notion of a grid diff, no custom wire format, and no knowledge that a daemon
 * exists — which is also why a browser client needs no adaptation here at all.
 */
export interface TerminalRendering {
  /**
   * Feed bytes from the daemon. Repaint sequences, indistinguishable from what a
   * child process would have written.
   */
  feed(bytes: Uint8Array): void;

  /**
   * The size this surface can display, in cells.
   *
   * Reported to the daemon on attach and on resize. The daemon sizes the PTY to the
   * *smallest* attached viewport, so this is a vote rather than a command.
   */
  readonly viewport: GridSize;

  /** Called when the user resizes; the client forwards it as a `resize` message. */
  onViewportChange: ((size: GridSize) => void) | undefined;

  /**
   * Keyboard input, sent straight on with no interpretation.
   *
   * Janela implements no key bindings the terminal should own. Splits and tabs use
   * `⌘` chords precisely so this stays true; a surface that swallowed a `Ctrl`
   * sequence would break the program running in it.
   *
   * Bytes, not a string. A surface that hands up decoded text has already lost the
   * distinction between a paste of invalid UTF-8 and a paste of replacement
   * characters.
   */
  onInput: ((bytes: Uint8Array) => void) | undefined;

  /**
   * Selected text, for Copy.
   *
   * Selection is client-side: two clients attached to one terminal select
   * independently, because a selection is a thing a person is doing, not a property
   * of the process.
   */
  selectedText(): string | undefined;

  /** Clears the local view without touching the daemon's scrollback. */
  clearViewport(): void;

  dispose(): void;
}
