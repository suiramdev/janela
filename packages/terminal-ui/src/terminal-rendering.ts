import type { GridSize } from "@janela/core";

export interface TerminalRendering {
  feed(bytes: Uint8Array): void;

  readonly viewport: GridSize;

  onViewportChange: ((size: GridSize) => void) | undefined;

  onInput: ((bytes: Uint8Array) => void) | undefined;

  selectedText(): string | undefined;

  paste(text: string): void;

  clearViewport(): void;

  dispose(): void;
}
