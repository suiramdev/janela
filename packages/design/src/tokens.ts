export const GRID_UNIT = 4;

export const SIDEBAR_WIDTH = { minimum: 180, ideal: 240, maximum: 400 } as const;

export const CORNER_RADIUS = { small: 6, medium: 10 } as const;

export const TERMINAL_INSETS = { top: 8, leading: 10, bottom: 8, trailing: 6 } as const;

export const COLOR = {
  terminalBackground: "--janela-terminal-background",
  attention: "--janela-attention",
  success: "--janela-success",
  failure: "--janela-failure",
} as const;

export const TERMINAL_SYMBOL_FONT = "Symbols Nerd Font Mono";

export const TERMINAL_FONT_STACK = `"SF Mono", "Menlo", "DejaVu Sans Mono", "${TERMINAL_SYMBOL_FONT}", ui-monospace, monospace`;
