import type { GridSize } from "@janela/core";
import type { TerminalBytes } from "@janela/pty";

/**
 * The seam between Janela and whatever parses VT sequences for us.
 *
 * Today this is backed by `@xterm/headless`. It may not always be, and the cost of
 * finding that out later is exactly the size of this interface. Keep it small.
 *
 * **Nothing above `@janela/terminal` may import an emulator library.** If you find
 * yourself wanting to, the missing capability belongs here instead. That rule is
 * enforced by `scripts/layers.ts`, not by review.
 *
 * See docs/decisions/0018-terminal-engine.md.
 */
export interface TerminalEmulating {
  /**
   * Feed bytes from the PTY.
   *
   * Called at most once per frame with a coalesced chunk. Chunk size is not a
   * detail: measured against `@xterm/headless`, 8 KB writes sustain ~6 MB/s and
   * 1 MB writes sustain ~140 MB/s, so the throughput budget in
   * docs/performance.md is met by *how* this is called as much as by what
   * implements it.
   */
  feed(bytes: TerminalBytes): void;

  /** Current grid size, in cells. */
  readonly size: GridSize;

  /** Resize the grid. Reflow behaviour is the emulator's business. */
  resize(size: GridSize): void;

  /**
   * A monotonically increasing revision, bumped whenever the grid changes.
   *
   * The handle for damage tracking: a client that last saw revision N asks what
   * changed since N. Cheap to read, and reading it must not be a synchronisation
   * point — it is polled once per frame per attached client.
   */
  readonly revision: number;

  /**
   * The shortest escape sequence that repaints everything changed since
   * `revision`.
   *
   * Returns an empty view when nothing changed, which is the common case and must
   * be cheap. Called once per frame per attached client.
   */
  repaintSince(revision: number): Uint8Array;

  /**
   * The whole grid as escape sequences.
   *
   * Sent on attach, and what makes reattaching correct rather than lucky: a byte
   * replay of recent output reconstructs a full-screen TUI only by luck, because
   * alternate-screen switches, partial sequences and cleared scrollback all make
   * it a guess. Verified in the migration spike: a 100×30 alternate-screen TUI
   * round-tripped through this and compared byte-identical, cursor position and
   * buffer type included.
   *
   * A correct-but-dumb full repaint every frame is always a valid fallback for
   * `repaintSince`, and that is deliberate: it means the hard optimisation can
   * never make us wrong, only slow.
   */
  fullRepaint(): Uint8Array;

  /**
   * Everything currently on screen and in scrollback, as plain text.
   *
   * This is what makes a CLI useful to an agent: "what is on screen in the build
   * terminal" is a protocol request rather than a screen-scrape. May be expensive;
   * never call it per frame.
   */
  snapshotText(options: { readonly includeScrollback: boolean }): string;

  /** Clears scrollback without disturbing the visible screen. */
  clearScrollback(): void;

  /** Where the emulator reports notable events. */
  events: TerminalEventSink | undefined;

  /** Releases the emulator's buffers. */
  dispose(): void;
}

/**
 * Events the emulator surfaces to the rest of the daemon.
 *
 * This list is deliberately short and deliberately *mechanical*. Every entry
 * corresponds to a real escape sequence or a real process event. There is no
 * `agentIsThinking`, because no terminal sequence means that. See
 * docs/decisions/0006-agent-activity-signals.md.
 */
export interface TerminalEventSink {
  /** OSC 0 / OSC 2 — the process set the window or icon title. */
  onTitle(title: string): void;

  /**
   * OSC 7 — the shell reported its working directory.
   *
   * How a session header can show where you actually are. Requires shell
   * integration the user may not have; absence is normal, and no feature may block
   * on it.
   */
  onWorkingDirectory(path: string): void;

  /**
   * BEL, OSC 9, or OSC 777 — the process is asking for attention.
   *
   * The only signal Janela uses to badge a background session, and the same signal
   * a `make && echo -e "\a"` produces. Note this arrives per *terminal*, not per
   * session: a session's badge is derived from its panes. Whether it also becomes a
   * notification is policy, and policy lives in `@janela/client`, because only a
   * client knows what is focused. This layer reports; it does not decide.
   */
  onAttention(notification: TerminalNotification): void;

  /**
   * OSC 133 semantic prompt marks, when the shell emits them. Used to time
   * long-running commands and to make "notify me when this finishes" accurate.
   */
  onPromptMark(mark: PromptMark): void;

  /** The child process exited. */
  onExit(code: number): void;
}

export interface TerminalNotification {
  readonly title?: string;
  readonly body?: string;
}

/** OSC 133 shell-integration markers. */
export type PromptMark =
  /** `OSC 133 ; A` — a new prompt is about to be drawn. */
  | { readonly kind: "promptStart" }
  /** `OSC 133 ; C` — the user's command started executing. */
  | { readonly kind: "commandStart" }
  /** `OSC 133 ; D ; <code>` — the command finished. */
  | { readonly kind: "commandFinished"; readonly exitCode?: number };

/**
 * Builds the production emulator.
 *
 * The single place an emulator library is named. `scrollback` is bounded here
 * rather than by the caller because an unbounded ring buffer is the most obvious
 * way to violate non-negotiable #9, and the bound belongs next to the thing it
 * bounds.
 */
export function createEmulator(options: {
  readonly size: GridSize;
  readonly scrollback: number;
}): TerminalEmulating {
  void options;
  throw new Error(`not implemented: createEmulator`);
}

/** Lines of scrollback per terminal. Bounded, and the bound is documented. */
export const DEFAULT_SCROLLBACK = 10_000;
