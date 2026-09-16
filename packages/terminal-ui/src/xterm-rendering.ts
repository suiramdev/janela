import type { GridSize } from "@janela/core";
import { TERMINAL_FONT_STACK, TERMINAL_INSETS } from "@janela/design";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { Option } from "effect";

import "@xterm/xterm/css/xterm.css";

import { MINIMUM_GRID, gridThatFits, letterboxMargins, type PixelSize } from "./grid-fit.ts";
import { mediaQueryLists } from "./media-queries.ts";
import type { TerminalRendering } from "./terminal-rendering.ts";

export interface TerminalFont {
  readonly family: string | undefined;

  readonly size: number;
}

export interface XtermRenderingOptions {
  readonly container: HTMLElement;

  readonly font: TerminalFont;

  readonly screenReaderMode?: boolean;

  readonly reducedMotion?: boolean;
}

export interface XtermRendering extends TerminalRendering {
  focus(): void;

  setFont(font: TerminalFont): void;
}

export const CLIENT_SCROLLBACK_LINES = 10_000;

const APPEARANCE_QUERIES = ["(prefers-color-scheme: dark)", "(prefers-contrast: more)"];

const loadWebgl = Option.liftThrowable((terminal: Terminal) => {
  const addon = new WebglAddon();
  terminal.loadAddon(addon);

  return addon;
});

function bytesOfBinaryString(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);

  for (let index = 0; index < data.length; index += 1) {
    bytes[index] = data.charCodeAt(index) & 0xff;
  }

  return bytes;
}

export function xtermRendering(options: XtermRenderingOptions): XtermRendering {
  const container = options.container;

  function backgroundBehind(): string | undefined {
    const behind = getComputedStyle(container).backgroundColor;

    if (behind === "" || behind === "transparent" || behind === "rgba(0, 0, 0, 0)") {
      return undefined;
    }

    return behind;
  }

  const background = backgroundBehind();

  const terminal = new Terminal({
    fontFamily: options.font.family ?? TERMINAL_FONT_STACK,
    fontSize: options.font.size,
    scrollback: CLIENT_SCROLLBACK_LINES,
    cursorBlink: options.reducedMotion !== true,
    screenReaderMode: options.screenReaderMode === true,
    windowOptions: { setWinSizeChars: true },
    allowProposedApi: true,
    theme: background === undefined ? {} : { background },
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);

  container.style.padding = `${TERMINAL_INSETS.top}px ${TERMINAL_INSETS.trailing}px ${TERMINAL_INSETS.bottom}px ${TERMINAL_INSETS.leading}px`;
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  container.append(host);
  terminal.open(host);

  const accelerated = Option.getOrUndefined(loadWebgl(terminal));

  let webgl: WebglAddon | undefined = accelerated;

  if (accelerated !== undefined) {
    accelerated.onContextLoss(() => {
      accelerated.dispose();
      webgl = undefined;
    });
  }

  const scroller = host.querySelector<HTMLElement>(".xterm-viewport");

  function syncBackground(): void {
    const behind = backgroundBehind();
    terminal.options.theme = behind === undefined ? {} : { background: behind };

    if (scroller !== null) scroller.style.backgroundColor = behind ?? "";
  }

  syncBackground();

  const appearances = mediaQueryLists(APPEARANCE_QUERIES);

  for (const query of appearances) query.addEventListener("change", syncBackground);

  const encoder = new TextEncoder();

  const rendering: XtermRendering = {
    get viewport(): GridSize {
      return { columns: terminal.cols, rows: terminal.rows };
    },
    onInput: undefined,
    onViewportChange: undefined,

    feed(bytes: Uint8Array): void {
      terminal.write(bytes);
    },

    selectedText(): string | undefined {
      return terminal.getSelection() || undefined;
    },

    paste(text: string): void {
      terminal.paste(text);
    },

    clearViewport(): void {
      terminal.clear();
    },

    focus(): void {
      terminal.focus();
    },

    setFont(font: TerminalFont): void {
      const family = font.family ?? TERMINAL_FONT_STACK;

      if (terminal.options.fontFamily === family && terminal.options.fontSize === font.size) {
        return;
      }

      terminal.options.fontFamily = family;
      terminal.options.fontSize = font.size;

      remeasure();
    },

    dispose(): void {
      observer.disconnect();

      for (const query of appearances) query.removeEventListener("change", syncBackground);

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

  function measureCell(): PixelSize | undefined {
    const screen = host.querySelector<HTMLElement>(".xterm-screen");

    if (screen === null) return undefined;

    const width = screen.clientWidth / terminal.cols;
    const height = screen.clientHeight / terminal.rows;

    if (!Number.isFinite(width) || width <= 0) return undefined;

    if (!Number.isFinite(height) || height <= 0) return undefined;

    return { width, height };
  }

  function proposedGrid(): GridSize | undefined {
    const proposed = fit.proposeDimensions();

    if (proposed === undefined) return undefined;

    if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return undefined;

    return {
      columns: Math.max(MINIMUM_GRID.columns, Math.floor(proposed.cols)),
      rows: Math.max(MINIMUM_GRID.rows, Math.floor(proposed.rows)),
    };
  }

  let lastCell: PixelSize | undefined;

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

  const windowSize = terminal.parser.registerCsiHandler({ final: "t" }, (parameters) => {
    if (parameters[0] !== 8) return false;

    const rows = parameters[1];
    const columns = parameters[2];

    if (rows === undefined || Array.isArray(rows)) return true;

    if (columns === undefined || Array.isArray(columns)) return true;

    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows <= 0 || columns <= 0) {
      return true;
    }

    if (columns !== terminal.cols || rows !== terminal.rows) {
      terminal.resize(columns, rows);
    }

    if (lastCell !== undefined) applyLetterbox(lastCell);

    return true;
  });

  const observer = new ResizeObserver(() => {
    remeasure();
  });

  observer.observe(container);

  return rendering;
}
