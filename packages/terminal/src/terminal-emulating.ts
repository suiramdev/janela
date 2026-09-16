import type { GridSize } from "@janela/core";
import type { TerminalBytes } from "@janela/pty";

export interface TerminalEmulating {
  feed(bytes: TerminalBytes): void;
  readonly size: GridSize;
  resize(size: GridSize): void;
  readonly revision: number;
  repaintSince(revision: number): Uint8Array;
  fullRepaint(): Uint8Array;
  snapshotText(options: { readonly includeScrollback: boolean }): string;
  clearScrollback(): void;
  events: TerminalEventSink | undefined;
  dispose(): void;
}

export interface TerminalEventSink {
  onTitle(title: string): void;
  onWorkingDirectory(path: string): void;
  onAttention(notification: TerminalNotification): void;
  onPromptMark(mark: PromptMark): void;
  onExit(code: number): void;
}

export interface TerminalNotification {
  readonly title?: string;
  readonly body?: string;
}

export type PromptMark =
  | { readonly kind: "promptStart" }
  | { readonly kind: "commandStart" }
  | { readonly kind: "commandFinished"; readonly exitCode?: number };

export const DEFAULT_SCROLLBACK = 10_000;

export const MAX_OSC_TEXT_LENGTH = 1024;
