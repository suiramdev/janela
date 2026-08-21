import { UserFacingError } from "@janela/support";

import type { TerminalBytes } from "./byte-stream.ts";
import type { TerminalSize } from "./size.ts";

/**
 * A pseudo-terminal and the child attached to its replica.
 *
 * This type is intentionally low-level and non-generic. It knows about file
 * descriptors, `fork`, `login_tty` and `ioctl`, and nothing about sessions,
 * agents, or views. It is the layer we profile in isolation and the layer we must
 * keep allocation-free on the read path.
 *
 * ## The spawn shape is not negotiable
 *
 * **A child needs a controlling terminal, and only `fork` can give it one.**
 * Darwin's `posix_spawn` has no `TIOCSCTTY` file action, and `POSIX_SPAWN_SETSID`
 * yields a new session *without* a controlling terminal. `TIOCSCTTY` must be
 * issued by the child, after `setsid()`, which means it must happen between fork
 * and exec.
 *
 * Without a controlling terminal, job control breaks: Ctrl-C delivers no `SIGINT`,
 * `tcsetpgrp` fails, and any TUI that opens `/dev/tty` misbehaves. Every coding
 * agent we care about is such a TUI.
 *
 * So the only correct implementation is:
 *
 *     openpty() → fork() → [child] login_tty(replica); chdir; execve()
 *
 * and it cannot be written in JavaScript: between `fork` and `execve` the child
 * may call only async-signal-safe functions, and a JavaScript runtime returning
 * from a foreign-function call into its own scheduler is the opposite of that.
 * This is why `@janela/pty` owns a small Rust cdylib and is the only package
 * permitted to import `bun:ffi`. See docs/decisions/0021-pty-native-layer.md.
 *
 * ## Ctrl-C is a byte, not a signal
 *
 * Interrupting the foreground job means **writing `0x03`** and letting the tty
 * line discipline deliver `SIGINT` to whatever process group is in the foreground
 * — which is what a real terminal does, and the only thing that is correct when
 * the shell has put a pipeline in its own process group. `signal()` below is for
 * *teardown*, where we do mean the whole session.
 *
 * ## Lazy by default
 *
 * Nothing is allocated until `spawn`. That is what makes 40 configured terminals
 * viable and why `idle` is a first-class `TerminalState`.
 */
export interface PseudoTerminal {
  /** The child's pid, which `login_tty` also made its process-group id. */
  readonly pid: number;

  /**
   * Everything buffered since the last call, as a view into a reusable buffer.
   *
   * Returns an empty view when there is nothing, and `undefined` once the child is
   * gone and the buffer is drained. Called once per frame by the daemon — see
   * `byte-stream.ts` for why that is the design rather than a compromise.
   */
  drain(): TerminalBytes | undefined;

  /** Writes user input to the child. Handles partial writes and `EAGAIN`. */
  write(bytes: Uint8Array): void;

  /**
   * Applies a new window size and signals `SIGWINCH`.
   *
   * Resizes are extremely frequent during a live divider drag. Callers must
   * coalesce: see docs/performance.md § Interaction.
   */
  resize(size: TerminalSize): void;

  /**
   * Sends a signal to the child's *process group*.
   *
   * For teardown, not for Ctrl-C — see the note above. Signalling only the direct
   * child leaves grandchildren orphaned and running.
   */
  signal(signal: number): void;

  /**
   * The child's exit status once it has been reaped, otherwise `undefined`.
   *
   * A signal death is reported as `128 + signo`, matching a shell. Verified in the
   * migration spike, including that the host runtime does not reap our children
   * out from under us — if it did, `TerminalState.exited(code)` would be
   * unimplementable.
   */
  exitCode(): number | undefined;

  /**
   * Hangs up: `SIGHUP` to the process group, then lets the reader thread wind
   * itself down and close the descriptor.
   *
   * Never blocks, and never closes the descriptor from the calling thread.
   * Idempotent.
   */
  close(): void;
}

/** Everything needed to start a child on a new PTY. */
export interface PseudoTerminalConfiguration {
  /**
   * Absolute path to the executable. Resolved by the caller; this layer does not
   * search `PATH`, because doing so correctly requires the user's environment,
   * which is a higher-level concern.
   */
  readonly executable: string;

  /**
   * Full argument vector *including* `argv[0]`.
   *
   * Login shells need `argv[0]` to begin with `-` (e.g. `-zsh`) or they will not
   * source the user's profile, which is the single most common cause of "my PATH
   * is wrong in this terminal app".
   */
  readonly arguments: readonly string[];

  readonly workingDirectory: string;

  /**
   * The complete environment for the child. Not merged with the parent's — the
   * caller decides exactly what the child sees.
   */
  readonly environment: Readonly<Record<string, string>>;

  readonly initialSize: TerminalSize;
}

export type PseudoTerminalFailureDetail =
  | { readonly kind: "couldNotAllocateTerminal"; readonly errno: number }
  | { readonly kind: "couldNotStart"; readonly path: string; readonly errno: number }
  | { readonly kind: "notRunning" };

export class PseudoTerminalFailure extends UserFacingError {
  override readonly summary: string;
  readonly detail: PseudoTerminalFailureDetail;

  constructor(detail: PseudoTerminalFailureDetail) {
    super(detail.kind);
    this.detail = detail;
    this.summary = summarize(detail);
  }
}

function summarize(detail: PseudoTerminalFailureDetail): string {
  switch (detail.kind) {
    case "couldNotAllocateTerminal":
      return "Couldn't open a terminal.";
    case "couldNotStart":
      return `Couldn't start ${detail.path}.`;
    case "notRunning":
      return "This terminal isn't running.";
  }
}

/**
 * Spawns the child and returns once the PTY is ready to read.
 *
 * @throws {PseudoTerminalFailure}
 */
export function spawnPseudoTerminal(configuration: PseudoTerminalConfiguration): PseudoTerminal {
  void configuration;
  throw new Error(`not implemented: spawnPseudoTerminal`);
}

/** Signal numbers this package uses, so callers need no magic constants. */
export const SIGNAL = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as const;

/** The byte that means "interrupt the foreground job". Write it; do not signal. */
export const CTRL_C = 0x03;
