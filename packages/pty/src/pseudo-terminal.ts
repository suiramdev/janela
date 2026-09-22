import { UserFacingError } from "@janela/support";
import { Data, Match } from "effect";

import {
  cString,
  cStringArray,
  JPTY_EXEC_FAILED_BIAS,
  JPTY_NO_EXIT_CODE,
  JPTY_READ_FAILED_BIAS,
  native,
  ptr,
  type NativePtyLibrary,
  type PtyHandle,
} from "./bindings.ts";
import { DRAIN_BUFFER_SIZE, type TerminalBytes } from "./byte-stream.ts";
import type { TerminalSize } from "./size.ts";

export interface PseudoTerminal {
  readonly pid: number;
  readonly readFailure: PseudoTerminalFailure | undefined;
  drain(): TerminalBytes | undefined;
  write(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  signal(signal: number): void;
  exitCode(): number | undefined;
  close(): void;
}

export interface PseudoTerminalConfiguration {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: TerminalSize;
  readonly replicaPathVariable?: string;
}

export type PseudoTerminalFailureDetail =
  | CouldNotAllocateTerminal
  | CouldNotStart
  | NotRunning
  | ReadFailed;

export const SIGNAL = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as const;

export const CTRL_C = 0x03;

const WINSIZE_FIELD_MAXIMUM = 0xffff;

export class CouldNotAllocateTerminal extends Data.TaggedClass("couldNotAllocateTerminal")<{
  readonly errno: number;
}> {}

export class CouldNotStart extends Data.TaggedClass("couldNotStart")<{
  readonly path: string;
  readonly errno: number;
}> {}

export class ReadFailed extends Data.TaggedClass("readFailed")<{
  readonly errno: number;
}> {}

export class NotRunning extends Data.TaggedClass("notRunning")<Record<never, never>> {}

export class PseudoTerminalFailure extends UserFacingError {
  override readonly summary: string;

  readonly detail: PseudoTerminalFailureDetail;

  constructor(detail: PseudoTerminalFailureDetail) {
    super(pseudoTerminalFailureLabel(detail));
    this.detail = detail;
    this.summary = summarize(detail);
  }
}

class NativePseudoTerminal implements PseudoTerminal {
  readonly pid: number;

  readFailure: PseudoTerminalFailure | undefined;

  private readonly library: NativePtyLibrary;

  private readonly handle: PtyHandle;

  private readonly drainBuffer = new Uint8Array(DRAIN_BUFFER_SIZE);

  private readonly empty: TerminalBytes;

  private running = true;

  private closed = false;

  private exitStatus: number | undefined;

  constructor(library: NativePtyLibrary, handle: PtyHandle, pid: number) {
    this.library = library;
    this.handle = handle;
    this.pid = pid;
    this.empty = this.drainBuffer.subarray(0, 0);
  }

  drain(): TerminalBytes | undefined {
    if (!this.running) {
      return undefined;
    }

    const drained = Number(
      this.library.jpty_read(this.handle, ptr(this.drainBuffer), this.drainBuffer.length),
    );

    if (drained > 0) {
      return this.drainBuffer.subarray(0, drained);
    }

    if (drained === 0) {
      return this.empty;
    }

    this.running = false;
    this.cacheExitCode();

    if (drained <= -JPTY_READ_FAILED_BIAS) {
      this.readFailure = new PseudoTerminalFailure(
        new ReadFailed({ errno: -drained - JPTY_READ_FAILED_BIAS }),
      );
    }

    return undefined;
  }

  write(bytes: Uint8Array): void {
    if (!this.running) {
      throw new PseudoTerminalFailure(new NotRunning());
    }

    if (bytes.length === 0) {
      return;
    }

    const written = Number(this.library.jpty_write(this.handle, ptr(bytes), bytes.length));

    if (written < bytes.length) {
      throw new PseudoTerminalFailure(new NotRunning());
    }
  }

  resize(size: TerminalSize): void {
    if (!this.running) {
      throw new PseudoTerminalFailure(new NotRunning());
    }

    this.library.jpty_resize(
      this.handle,
      clampToWinsizeField(size.columns),
      clampToWinsizeField(size.rows),
      clampToWinsizeField(size.pixelWidth),
      clampToWinsizeField(size.pixelHeight),
    );
  }

  signal(signal: number): void {
    if (!this.running) {
      throw new PseudoTerminalFailure(new NotRunning());
    }

    this.library.jpty_signal(this.handle, signal);
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
    this.library.jpty_close(this.handle);
  }

  private cacheExitCode(): void {
    const code = this.library.jpty_exit_code(this.handle);

    if (code !== JPTY_NO_EXIT_CODE) {
      this.exitStatus = code;
    }
  }
}

export function pseudoTerminalFailureLabel(detail: PseudoTerminalFailureDetail): string {
  return Match.value(detail).pipe(
    Match.tag("couldNotAllocateTerminal", () => "couldNotAllocateTerminal"),
    Match.tag("couldNotStart", () => "couldNotStart"),
    Match.tag("readFailed", () => "readFailed"),
    Match.tag("notRunning", () => "notRunning"),
    Match.exhaustive,
  );
}

function summarize(detail: PseudoTerminalFailureDetail): string {
  return Match.value(detail).pipe(
    Match.tag("couldNotAllocateTerminal", () => "Couldn't open a terminal."),
    Match.tag("couldNotStart", (failure) => `Couldn't start ${failure.path}.`),
    Match.tag("readFailed", () => "Couldn't read from this terminal."),
    Match.tag("notRunning", () => "This terminal isn't running."),
    Match.exhaustive,
  );
}

function clampToWinsizeField(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(WINSIZE_FIELD_MAXIMUM, Math.max(0, Math.trunc(value)));
}

function spawnFailure(code: number, executable: string): PseudoTerminalFailure {
  if (code <= -JPTY_EXEC_FAILED_BIAS) {
    return new PseudoTerminalFailure(
      new CouldNotStart({ path: executable, errno: -code - JPTY_EXEC_FAILED_BIAS }),
    );
  }

  return new PseudoTerminalFailure(new CouldNotAllocateTerminal({ errno: -code }));
}

export function spawnPseudoTerminal(
  configuration: PseudoTerminalConfiguration,
  library: NativePtyLibrary = native,
): PseudoTerminal {
  const executable = cString(configuration.executable);
  const workingDirectory = cString(configuration.workingDirectory);
  const argumentVector = cStringArray(configuration.arguments);
  const environmentVector = cStringArray(
    Object.entries(configuration.environment).map(([key, value]) => `${key}=${value}`),
  );

  const replicaPathVariable =
    configuration.replicaPathVariable === undefined
      ? undefined
      : cString(configuration.replicaPathVariable);

  const pidOut = new Int32Array(1);
  const reachableUntilTheChildHasExeced = [
    executable,
    workingDirectory,
    argumentVector,
    environmentVector,
    replicaPathVariable,
    pidOut,
  ];

  const handle = library.jpty_spawn(
    ptr(executable),
    ptr(argumentVector.pointers),
    ptr(environmentVector.pointers),
    ptr(workingDirectory),
    replicaPathVariable === undefined ? null : ptr(replicaPathVariable),
    clampToWinsizeField(configuration.initialSize.columns),
    clampToWinsizeField(configuration.initialSize.rows),
    ptr(pidOut),
  );

  void reachableUntilTheChildHasExeced;

  if (handle < 0) {
    throw spawnFailure(handle, configuration.executable);
  }

  /* SAFETY: the negative band is the whole of `jpty_spawn`'s failure surface and
     was refused on the line above, so what remains is an index into the native
     terminal table. `PtyHandle` is a nominal brand with no runtime form, so
     branding is the only way to record that check. */
  const opened = handle as PtyHandle;
  const spawnedPid = pidOut[0];

  if (spawnedPid === undefined) {
    throw new PseudoTerminalFailure(new CouldNotAllocateTerminal({ errno: 0 }));
  }

  const terminal = new NativePseudoTerminal(library, opened, spawnedPid);

  if (configuration.initialSize.pixelWidth > 0 || configuration.initialSize.pixelHeight > 0) {
    terminal.resize(configuration.initialSize);
  }

  return terminal;
}

export function hangUpEveryPseudoTerminal(): number {
  return native.jpty_drop_all();
}
