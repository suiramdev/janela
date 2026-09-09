/**
 * `TerminalRendering` over `@xterm/xterm`.
 *
 * **The only module in the repository's client half that names a renderer
 * library** — the other side of the same rule `@janela/terminal` obeys for the
 * emulator, enforced by `scripts/layers.ts` rather than by review (ADR 0018).
 *
 * ## What this does not do
 *
 * It does not spawn anything: the library will happily start a process and that is
 * the daemon's job now. It does not interpret input — bytes in, bytes out. And it
 * binds no keys of its own, `Ctrl` or otherwise: the terminal owns the keyboard
 * (AGENTS.md § Non-negotiables 4).
 *
 * ## Screen readers, recorded honestly
 *
 * With `screenReaderMode` off — the default, because it costs on the hot path —
 * xterm paints to a canvas and exposes only a focusable textarea. A screen reader
 * gets this surface's accessible name and the echo of what is typed, but **not the
 * output content**. With it on, xterm maintains off-screen live regions that
 * announce new lines. Neither mode offers cell-level navigation or a braille-
 * friendly buffer. The option is a prop rather than a constant so #38's settings
 * can turn it on; nothing here decides for the user.
 */

import type { GridSize } from "@janela/core";
import { TERMINAL_FONT_STACK, TERMINAL_INSETS } from "@janela/design";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

import { MINIMUM_GRID, gridThatFits, letterboxMargins, type PixelSize } from "./grid-fit.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

/**
 * How much this client keeps.
 *
 * A documented bound, because terminal output is effectively infinite
 * (AGENTS.md § Non-negotiables 9). This is a local echo of what this client has
 * seen; the authoritative scrollback is the daemon's, and an attach replies with a
 * full repaint, so losing the oldest lines here loses nothing that cannot be asked
 * for again.
 */
export const CLIENT_SCROLLBACK_LINES = 10_000;

export interface XtermRenderingOptions {
  /**
   * The element to draw in. Its padding and its children are managed here — pass
   * an element that exists for this purpose and nothing else.
   */
  readonly container: HTMLElement;

  /** xterm's live-region announcements. Off by default; see the file header. */
  readonly screenReaderMode?: boolean;

  /** Disables the cursor blink. Wired to `prefers-reduced-motion` by the caller. */
  readonly reducedMotion?: boolean;
}

export interface XtermRendering extends TerminalRendering {
  /** Moves DOM focus into the terminal's textarea. */
  focus(): void;
}

/** xterm's `onBinary` carries raw bytes as a string: one character, one byte. */
function bytesOfBinaryString(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }
  return bytes;
}

export function xtermRendering(options: XtermRenderingOptions): XtermRendering {
  const container = options.container;

  const terminal = new Terminal({
    fontFamily: TERMINAL_FONT_STACK,
    scrollback: CLIENT_SCROLLBACK_LINES,
    cursorBlink: options.reducedMotion !== true,
    screenReaderMode: options.screenReaderMode === true,
    // `CSI 8 ; rows ; cols t` — the daemon's negotiated grid (protocol 5) — is
    // gated on this flag before any handler sees it. The library then implements
    // no case for parameter 8, so the resize below is ours. See the handler.
    windowOptions: { setWinSizeChars: true },
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);

  // The grid is drawn into its own element sized to whole cells, inside a padded
  // container that paints the background. That is the letterbox: the grid is never
  // scaled — a scaled monospace grid is a blurry one — so whatever the grid does
  // not cover shows the container through.
  container.style.padding = `${TERMINAL_INSETS.top}px ${TERMINAL_INSETS.trailing}px ${TERMINAL_INSETS.bottom}px ${TERMINAL_INSETS.leading}px`;
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  container.append(host);
  terminal.open(host);

  let webgl: WebglAddon | undefined;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      webgl = undefined;
    });
    terminal.loadAddon(addon);
    webgl = addon;
  } catch {
    // The canvas renderer is the fallback and it is correct, only slower. A
    // machine without a WebGL context must not lose its terminal over it.
    webgl = undefined;
  }

  const encoder = new TextEncoder();

  const rendering: XtermRendering = {
    get viewport(): GridSize {
      // What it holds, not what was asked for: xterm clamps, and a vote that
      // disagreed with the grid would put the negotiated PTY size out of step.
      return { columns: terminal.cols, rows: terminal.rows };
    },
    onInput: undefined,
    onViewportChange: undefined,

    feed(bytes: Uint8Array): void {
      // No copy here on purpose. `write()` queues its argument, so a caller
      // holding a transient view — `DaemonConnection.onOutput` hands one up —
      // must copy first; `createSurfaceController` is where that happens.
      terminal.write(bytes);
    },

    selectedText(): string | undefined {
      return terminal.getSelection() || undefined;
    },

    clearViewport(): void {
      // Local only. The daemon's scrollback is untouched, which is why this is
      // safe to offer to one client while another is attached.
      terminal.clear();
    },

    focus(): void {
      terminal.focus();
    },

    dispose(): void {
      observer.disconnect();
      windowSize.dispose();
      for (const subscription of subscriptions) subscription.dispose();
      webgl?.dispose();
      fit.dispose();
      terminal.dispose();
      host.remove();
    },
  };

  const subscriptions = [
    terminal.onData((data) => {
      rendering.onInput?.(encoder.encode(data));
    }),
    // The non-UTF-8 paste path. Decoding it to text and re-encoding would turn an
    // invalid-UTF-8 paste into replacement characters.
    terminal.onBinary((data) => {
      rendering.onInput?.(bytesOfBinaryString(data));
    }),
  ];

  function contentBox(): PixelSize {
    return {
      width: container.clientWidth - TERMINAL_INSETS.leading - TERMINAL_INSETS.trailing,
      height: container.clientHeight - TERMINAL_INSETS.top - TERMINAL_INSETS.bottom,
    };
  }

  /**
   * The cell size, read from what xterm actually drew.
   *
   * `.xterm-screen` is sized to `cols × rows` cells by the renderer, so dividing
   * gives the real metrics — no private `_core` access, and no font measurement of
   * our own to disagree with xterm's. Undefined until the first paint, which is
   * also "before the font has loaded".
   */
  function measureCell(): PixelSize | undefined {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    if (screen === null) return undefined;
    const width = screen.clientWidth / terminal.cols;
    const height = screen.clientHeight / terminal.rows;
    if (!Number.isFinite(width) || width <= 0) return undefined;
    if (!Number.isFinite(height) || height <= 0) return undefined;
    return { width, height };
  }

  /** The fallback for the first tick, before there is anything drawn to measure. */
  function proposedGrid(): GridSize | undefined {
    const proposed = fit.proposeDimensions();
    if (proposed === undefined) return undefined;
    if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return undefined;
    return {
      columns: Math.max(MINIMUM_GRID.columns, Math.floor(proposed.cols)),
      rows: Math.max(MINIMUM_GRID.rows, Math.floor(proposed.rows)),
    };
  }

  /**
   * The cell metric from the last container-driven measurement.
   *
   * The daemon-driven path letterboxes from this rather than measuring again, so
   * that the margin is derived from the same metric the grid was, and agrees with
   * it by construction. A cell is a font metric and does not change on resize.
   *
   * Measuring again would also work today — `measureCell()` inside the parse path
   * returned 8.803 px against this value's 8.800 on a real repaint, because the
   * render service sizes `.xterm-screen` synchronously inside `resize()`. That is
   * an ordering inside the library, and the cost of it changing is not one bad
   * frame: nothing re-measures until the container moves, so a wrong margin here
   * would simply stay.
   */
  let lastCell: PixelSize | undefined;

  /**
   * Sizes the grid element to whole cells, leaving the rest of the box showing
   * the container. Never scales: a scaled monospace grid is a blurry one.
   */
  function applyLetterbox(cell: PixelSize): void {
    const box = contentBox();
    const margins = letterboxMargins(box, cell, {
      columns: terminal.cols,
      rows: terminal.rows,
    });
    host.style.width = `${Math.max(0, box.width - margins.width)}px`;
    host.style.height = `${Math.max(0, box.height - margins.height)}px`;
  }

  function remeasure(): void {
    const box = contentBox();
    const cell = measureCell();
    const grid = cell === undefined ? proposedGrid() : gridThatFits(box, cell);
    // Nothing measurable yet — the fonts have not landed. The next observer tick
    // retries, and `viewport` stays whatever xterm holds until then.
    if (grid === undefined) return;

    if (grid.columns !== terminal.cols || grid.rows !== terminal.rows) {
      terminal.resize(grid.columns, grid.rows);
    }
    const held: GridSize = { columns: terminal.cols, rows: terminal.rows };

    if (cell !== undefined) {
      lastCell = cell;
      applyLetterbox(cell);
    }

    rendering.onViewportChange?.(held);
  }

  /**
   * The daemon's negotiated grid, applied without voting it back.
   *
   * The size arrives in the output stream because it belongs to the same ordered
   * bytes it describes (ADR 0016, protocol 5). Acting on it is this module's job
   * and not the library's: `@xterm/xterm` 6.0.0 gates parameter 8 on
   * `windowOptions.setWinSizeChars` and then falls off the end of its own switch,
   * so without this the sequence is parsed and dropped — the whole of defect D2.
   *
   * Every other parameter is handed back to the library: 18 answers a program's
   * size query, 22 and 23 push and pop its title, and none of them are ours.
   *
   * It deliberately does not call `onViewportChange`. This client's vote is what
   * it measured; voting the daemon's answer back would make the minimum sticky,
   * because a minimum echoed as a proposal can never grow again. `terminal.onResize`
   * stays unwired for the same reason.
   */
  const windowSize = terminal.parser.registerCsiHandler({ final: "t" }, (parameters) => {
    if (parameters[0] !== 8) return false;
    const rows = parameters[1];
    const columns = parameters[2];
    if (typeof rows !== "number" || typeof columns !== "number") return true;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows <= 0 || columns <= 0) {
      return true;
    }
    if (columns !== terminal.cols || rows !== terminal.rows) {
      terminal.resize(columns, rows);
    }
    // Before the first container measurement there is no cell metric to letterbox
    // with; the observer tick that produces one applies it.
    if (lastCell !== undefined) applyLetterbox(lastCell);
    return true;
  });

  // Only container-driven measurements vote. `terminal.onResize` is deliberately
  // not wired: it also fires for the daemon-driven `CSI 8 t` above, and voting
  // that back would turn the daemon's command into this client's proposal.
  const observer = new ResizeObserver(() => {
    remeasure();
  });
  observer.observe(container);

  return rendering;
}
