import { UserFacingError } from "@janela/support";

import {
  cString,
  cStringArray,
  JPTY_EXEC_FAILED_BIAS,
  JPTY_NO_EXIT_CODE,
  native,
  ptr,
  type PtyHandle,
} from "./bindings.ts";
import { DRAIN_BUFFER_SIZE, type TerminalBytes } from "./byte-stream.ts";
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
   * Up to `DRAIN_BUFFER_SIZE` of what is buffered, as a view into a reusable
   * buffer.
   *
   * Returns an empty view when there is nothing, and `undefined` once the child is
   * gone and the buffer is drained. Called once per frame by the daemon — see
   * `byte-stream.ts` for why that is the design rather than a compromise.
   *
   * When more than a buffer's worth is waiting, the remainder stays in the ring
   * and arrives on the next call: this never loops, because a frame's cost has to
   * stay bounded whatever one terminal is doing. Nothing is dropped, and the
   * native reader is woken after every non-empty drain, so the backlog always
   * makes progress.
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

/** `winsize` carries four `u16`s; `TerminalSize` carries four `number`s. */
function clampToWinsizeField(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(0xffff, Math.max(0, Math.trunc(value)));
}

/**
 * The one place native return codes become failures. The bands are disjoint by
 * construction on the native side, so this is a classification and not a guess:
 * a parent-side errno could not open a terminal, and a child-side one could not
 * start the program.
 */
function spawnFailure(code: number, executable: string): PseudoTerminalFailure {
  if (code <= -JPTY_EXEC_FAILED_BIAS) {
    return new PseudoTerminalFailure({
      kind: "couldNotStart",
      path: executable,
      errno: -code - JPTY_EXEC_FAILED_BIAS,
    });
  }
  return new PseudoTerminalFailure({ kind: "couldNotAllocateTerminal", errno: -code });
}

class NativePseudoTerminal implements PseudoTerminal {
  readonly pid: number;

  private readonly handle: PtyHandle;
  private readonly drainBuffer = new Uint8Array(DRAIN_BUFFER_SIZE);
  /** Held rather than allocated per call: an idle terminal drains 120 times a second. */
  private readonly empty: TerminalBytes;
  /** False once the child is gone or we hung up. Checked before every FFI call. */
  private running = true;
  private closed = false;
  private exitStatus: number | undefined;

  constructor(handle: PtyHandle, pid: number) {
    this.handle = handle;
    this.pid = pid;
    this.empty = this.drainBuffer.subarray(0, 0);
  }

  drain(): TerminalBytes | undefined {
    if (!this.running) {
      return undefined;
    }
    const drained = Number(
      native.jpty_read(this.handle, ptr(this.drainBuffer), this.drainBuffer.length),
    );
    if (drained > 0) {
      return this.drainBuffer.subarray(0, drained);
    }
    if (drained === 0) {
      return this.empty;
    }
    // The native side stores the exit code before it closes the ring, so the
    // status is readable in this same tick and `exitCode()` never needs the
    // boundary again.
    this.running = false;
    this.cacheExitCode();
    return undefined;
  }

  write(bytes: Uint8Array): void {
    if (!this.running) {
      throw new PseudoTerminalFailure({ kind: "notRunning" });
    }
    if (bytes.length === 0) {
      return;
    }
    const written = Number(native.jpty_write(this.handle, ptr(bytes), bytes.length));
    if (written < bytes.length) {
      // The native write loops over partial writes and `EINTR`, so anything short
      // is a descriptor that failed: the input was not delivered, and dropping a
      // keystroke silently is the one thing this layer must not do.
      throw new PseudoTerminalFailure({ kind: "notRunning" });
    }
  }

  resize(size: TerminalSize): void {
    if (!this.running) {
      throw new PseudoTerminalFailure({ kind: "notRunning" });
    }
    // A coalesced resize landing on a terminal that died a frame ago is routine,
    // and putting a dialog in front of the user for a race we caused would be
    // worse than ignoring it.
    native.jpty_resize(
      this.handle,
      clampToWinsizeField(size.columns),
      clampToWinsizeField(size.rows),
      clampToWinsizeField(size.pixelWidth),
      clampToWinsizeField(size.pixelHeight),
    );
  }

  signal(signal: number): void {
    if (!this.running) {
      throw new PseudoTerminalFailure({ kind: "notRunning" });
    }
    // `ESRCH` — the group is already gone — is the common case, not an error.
    native.jpty_signal(this.handle, signal);
  }

  exitCode(): number | undefined {
    if (this.exitStatus === undefined) {
      this.cacheExitCode();
    }
    return this.exitStatus;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.running = false;
    native.jpty_close(this.handle);
  }

  private cacheExitCode(): void {
    const code = native.jpty_exit_code(this.handle);
    if (code !== JPTY_NO_EXIT_CODE) {
      this.exitStatus = code;
    }
  }
}

/**
 * Spawns the child and returns once the PTY is ready to read.
 *
 * @throws {PseudoTerminalFailure}
 */
export function spawnPseudoTerminal(configuration: PseudoTerminalConfiguration): PseudoTerminal {
  const executable = cString(configuration.executable);
  const workingDirectory = cString(configuration.workingDirectory);
  const argumentVector = cStringArray(configuration.arguments);
  const environmentVector = cStringArray(
    Object.entries(configuration.environment).map(([key, value]) => `${key}=${value}`),
  );
  const pid = new Int32Array(1);
  // Named so the collector cannot reclaim a buffer whose address the native side
  // is holding, and touched again after the call. Releasing them there is
  // provable rather than hopeful: `jpty_spawn` returns only after the child has
  // exec'd — at which point the kernel has copied both vectors into the new
  // image — or died.
  const marshalled = [executable, workingDirectory, argumentVector, environmentVector, pid];

  const handle = native.jpty_spawn(
    ptr(executable),
    ptr(argumentVector.pointers),
    ptr(environmentVector.pointers),
    ptr(workingDirectory),
    clampToWinsizeField(configuration.initialSize.columns),
    clampToWinsizeField(configuration.initialSize.rows),
    ptr(pid),
  );
  void marshalled;

  if (handle < 0) {
    throw spawnFailure(handle, configuration.executable);
  }
  const spawnedPid = pid[0];
  if (spawnedPid === undefined) {
    throw new PseudoTerminalFailure({ kind: "couldNotAllocateTerminal", errno: 0 });
  }

  const terminal = new NativePseudoTerminal(handle as PtyHandle, spawnedPid);
  // `jpty_spawn` carries cells only, which is the whole of `DEFAULT_TERMINAL_SIZE`.
  // Pixel metrics cost an extra call, so only a client that actually has them
  // pays for one — and `SIGWINCH`'s default action is to discard, so a child that
  // has not exec'd yet is unaffected.
  if (configuration.initialSize.pixelWidth > 0 || configuration.initialSize.pixelHeight > 0) {
    terminal.resize(configuration.initialSize);
  }
  return terminal;
}

/**
 * Hangs up every live pseudo-terminal and returns how many there were.
 *
 * For the daemon's `SIGTERM` path, where children must get `SIGHUP` rather than
 * being reparented onto launchd. One synchronous native call rather than a loop
 * in the caller: an `await` point in the middle of a signal handler is exactly
 * where the process dies with the sweep half done, and a single call cannot be
 * half done.
 */
export function hangUpEveryPseudoTerminal(): number {
  return native.jpty_drop_all();
}

/** Signal numbers this package uses, so callers need no magic constants. */
export const SIGNAL = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as const;

/** The byte that means "interrupt the foreground job". Write it; do not signal. */
export const CTRL_C = 0x03;
