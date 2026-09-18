import type {
  AgentActivity,
  GridSize,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalProgress,
  TerminalState,
} from "@janela/core";
import {
  NotRunning,
  PseudoTerminalFailure,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalConfiguration,
} from "@janela/pty";
import { begin, type Logger, type Signpost } from "@janela/support";
import { Predicate, Result } from "effect";

import { createEmulator } from "./headless-emulator.ts";
import {
  DEFAULT_SCROLLBACK,
  type TerminalEmulating,
  type TerminalEventSink,
} from "./terminal-emulating.ts";

export interface LiveTerminal {
  readonly id: TerminalID;
  readonly sessionID: SessionID;
  readonly descriptor: TerminalDescriptor;
  readonly state: TerminalState;
  readonly displayTitle: string;
  readonly reportedWorkingDirectory?: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  send(bytes: Uint8Array): void;
  markAttention(raised: boolean): void;
  attach(client: string, viewport: GridSize): GridSize;
  detach(client: string): GridSize | undefined;
  drain(): void;
  repaintFor(client: string): Uint8Array;
  fullRepaintFor(client: string): Uint8Array;
  snapshotText(options: { readonly includeScrollback: boolean }): string;

  events: TerminalEvents | undefined;
}

export interface TerminalEvents extends TerminalEventSink {
  onPromptFinished(completion: PromptCompletion): void;
  onFailure(message: string): void;
}

export interface PromptCompletion {
  readonly durationSeconds: number;
  readonly exitCode?: number;
}

export interface TerminalLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: GridSize;
  readonly replicaPathVariable?: string;
}

export interface LiveTerminalOptions {
  readonly descriptor: TerminalDescriptor;
  readonly sessionID: SessionID;
  readonly launch: TerminalLaunch;
  readonly scrollback?: number;
  readonly log?: Logger;
  readonly spawn?: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
  readonly createEmulator?: (options: {
    readonly size: GridSize;
    readonly scrollback: number;
  }) => TerminalEmulating;
}

interface AttachedClient {
  viewport: GridSize;
  revision: number;
  owesSize: boolean;
  attachMark?: Signpost;
}

const EMPTY = new Uint8Array(0);

const NO_PIXEL_SIZE = { pixelWidth: 0, pixelHeight: 0 } as const;

const MILLISECONDS_PER_SECOND = 1000;

export function negotiatedSize(viewports: readonly GridSize[]): GridSize {
  const first = viewports[0];

  if (first === undefined) {
    throw new Error("negotiatedSize: at least one viewport is required");
  }

  let columns = first.columns;
  let rows = first.rows;

  for (let index = 1; index < viewports.length; index += 1) {
    const viewport = viewports[index];

    if (viewport === undefined) {
      continue;
    }

    if (viewport.columns < columns) {
      columns = viewport.columns;
    }

    if (viewport.rows < rows) {
      rows = viewport.rows;
    }
  }

  return { columns, rows };
}

export function createLiveTerminal(options: LiveTerminalOptions): LiveTerminal {
  return new PtyLiveTerminal(options);
}

function readFailureFields(
  terminal: TerminalID,
  errno: number | undefined,
  code: number | undefined,
) {
  if (errno === undefined) {
    return code === undefined ? { terminal } : { terminal, code };
  }

  return code === undefined ? { terminal, errno } : { terminal, errno, code };
}

class PtyLiveTerminal implements LiveTerminal {
  readonly id: TerminalID;
  readonly sessionID: SessionID;
  readonly descriptor: TerminalDescriptor;

  events: TerminalEvents | undefined;

  reportedWorkingDirectory?: string;

  private readonly launch: TerminalLaunch;
  private readonly scrollback: number;
  private readonly log: Logger | undefined;
  private readonly spawn: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
  private readonly makeEmulator: (options: {
    readonly size: GridSize;
    readonly scrollback: number;
  }) => TerminalEmulating;

  private pty: PseudoTerminal | undefined;
  private emulator: TerminalEmulating | undefined;
  private title: string | undefined;
  private exit: { readonly code: number } | undefined;
  private failure: string | undefined;
  private attention = false;
  private progress: TerminalProgress | undefined;
  private activity: AgentActivity | undefined;
  private commandStartedAt: number | undefined;

  private readonly clients = new Map<string, AttachedClient>();

  private readonly emulatorSink: TerminalEventSink = {
    onTitle: (title) => {
      this.title = title;
      this.events?.onTitle(title);
    },
    onWorkingDirectory: (path) => {
      this.reportedWorkingDirectory = path;
      this.events?.onWorkingDirectory(path);
    },
    onAttention: (notification) => {
      this.attention = true;
      this.events?.onAttention(notification);
    },
    onPromptMark: (mark) => {
      if (mark.kind === "commandStart") {
        this.commandStartedAt = Date.now();
      }

      this.events?.onPromptMark(mark);

      if (mark.kind !== "commandFinished") {
        return;
      }

      const startedAt = this.commandStartedAt;
      this.commandStartedAt = undefined;

      if (startedAt === undefined) {
        return;
      }

      const durationSeconds = (Date.now() - startedAt) / MILLISECONDS_PER_SECOND;

      this.events?.onPromptFinished(
        mark.exitCode === undefined
          ? { durationSeconds }
          : { durationSeconds, exitCode: mark.exitCode },
      );
    },
    onProgress: (progress) => {
      this.progress = progress;
      this.events?.onProgress(progress);
    },
    onActivity: (activity) => {
      this.activity = activity;
      this.attention = activity.kind !== "working";
      this.events?.onActivity(activity);
    },
    onExit: () => {
      throw new Error("the emulator knows nothing about processes; drain() emits onExit");
    },
  };

  constructor(options: LiveTerminalOptions) {
    this.id = options.descriptor.id;
    this.sessionID = options.sessionID;
    this.descriptor = options.descriptor;
    this.launch = options.launch;
    this.scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
    this.log = options.log;
    this.spawn = options.spawn ?? spawnPseudoTerminal;
    this.makeEmulator = options.createEmulator ?? createEmulator;
  }

  get state(): TerminalState {
    if (this.failure !== undefined) {
      return { kind: "failed", message: this.failure };
    }

    if (this.exit !== undefined) {
      return { kind: "exited", code: this.exit.code };
    }

    if (this.pty === undefined) {
      return { kind: "idle" };
    }

    const activity = this.activity;

    if (this.attention) {
      return activity === undefined
        ? { kind: "needsAttention" }
        : { kind: "needsAttention", activity };
    }

    const progress = this.progress;

    return {
      kind: "running",
      ...(progress !== undefined && { progress }),
      ...(activity !== undefined && { activity }),
    };
  }

  get displayTitle(): string {
    return this.title ?? this.descriptor.title;
  }

  async start(): Promise<void> {
    if (this.pty !== undefined) {
      return;
    }

    this.exit = undefined;
    this.failure = undefined;
    this.attention = false;
    this.progress = undefined;
    this.activity = undefined;
    this.commandStartedAt = undefined;
    this.title = undefined;
    delete this.reportedWorkingDirectory;
    this.emulator?.dispose();
    this.emulator = undefined;

    const size = this.clients.size > 0 ? negotiatedSize(this.viewports()) : this.launch.initialSize;
    const spawned = Result.try(() =>
      this.spawn({
        executable: this.launch.executable,
        arguments: this.launch.arguments,
        workingDirectory: this.launch.workingDirectory,
        environment: this.launch.environment,
        initialSize: { columns: size.columns, rows: size.rows, ...NO_PIXEL_SIZE },
        ...(this.launch.replicaPathVariable !== undefined && {
          replicaPathVariable: this.launch.replicaPathVariable,
        }),
      }),
    );

    if (Result.isFailure(spawned)) {
      const cause = spawned.failure;

      if (cause instanceof PseudoTerminalFailure) {
        this.failure = cause.summary;
      }

      throw cause;
    }

    this.pty = spawned.success;
    this.emulator = this.makeEmulator({ size, scrollback: this.scrollback });
    this.emulator.events = this.emulatorSink;

    for (const entry of this.clients.values()) {
      entry.revision = this.emulator.revision;
    }
  }

  async stop(): Promise<void> {
    this.pty?.close();
  }

  async restart(): Promise<void> {
    this.pty?.close();
    this.pty = undefined;
    await this.start();
  }

  drain(): void {
    const pty = this.pty;
    const emulator = this.emulator;

    if (pty === undefined || emulator === undefined) {
      return;
    }

    const bytes = pty.drain();

    if (bytes === undefined) {
      this.observeStreamEnd(pty);

      return;
    }

    if (bytes.length > 0) {
      emulator.feed(bytes);
    }
  }

  send(bytes: Uint8Array): void {
    const pty = this.pty;

    if (pty === undefined) {
      throw new PseudoTerminalFailure(new NotRunning());
    }

    pty.write(bytes);
    this.attention = false;
  }

  markAttention(raised: boolean): void {
    this.attention = raised;
  }

  attach(client: string, viewport: GridSize): GridSize {
    const existing = this.clients.get(client);

    if (existing === undefined) {
      this.clients.set(client, {
        viewport,
        revision: this.emulator?.revision ?? 0,
        owesSize: true,
        attachMark: begin("attach", this.id),
      });
    } else {
      existing.viewport = viewport;
    }

    const size = negotiatedSize(this.viewports());
    this.applySize(size);

    const entry = this.clients.get(client);
    const overruled = size.columns !== viewport.columns || size.rows !== viewport.rows;

    if (entry !== undefined && overruled) {
      entry.owesSize = true;
    }

    return size;
  }

  detach(client: string): GridSize | undefined {
    this.clients.get(client)?.attachMark?.end();
    this.clients.delete(client);

    if (this.clients.size === 0) {
      return undefined;
    }

    const size = negotiatedSize(this.viewports());
    this.applySize(size);

    return size;
  }

  repaintFor(client: string): Uint8Array {
    const entry = this.entryFor(client);
    const emulator = this.emulator;

    if (emulator === undefined) {
      return EMPTY;
    }

    if (entry.owesSize) {
      return this.fullRepaintFor(client);
    }

    const mark = begin("repaint", this.id);
    const bytes = emulator.repaintSince(entry.revision);
    entry.revision = emulator.revision;

    if (mark.observed) {
      mark.end({ client, bytes: bytes.length, full: false });
    } else {
      mark.end();
    }

    return bytes;
  }

  fullRepaintFor(client: string): Uint8Array {
    const entry = this.entryFor(client);
    const emulator = this.emulator;

    if (emulator === undefined) {
      return EMPTY;
    }

    const mark = begin("repaint", this.id);
    entry.revision = emulator.revision;
    entry.owesSize = false;
    this.attention = this.activity?.kind === "waiting" && this.attention;

    const bytes = emulator.fullRepaint();

    if (mark.observed) {
      mark.end({ client, bytes: bytes.length, full: true });
    } else {
      mark.end();
    }

    const attachMark = entry.attachMark;

    if (attachMark !== undefined) {
      if (attachMark.observed) {
        attachMark.end({ client, bytes: bytes.length });
      } else {
        attachMark.end();
      }

      delete entry.attachMark;
    }

    return bytes;
  }

  snapshotText(options: { readonly includeScrollback: boolean }): string {
    return this.emulator?.snapshotText(options) ?? "";
  }

  private observeStreamEnd(pty: PseudoTerminal): void {
    const readFailure = pty.readFailure;
    const code = pty.exitCode();

    if (readFailure !== undefined) {
      const errno = Predicate.isTagged(readFailure.detail, "readFailed")
        ? readFailure.detail.errno
        : undefined;

      this.failure = readFailure.summary;
      this.progress = undefined;
      this.commandStartedAt = undefined;
      this.log?.warning("terminal read failed", readFailureFields(this.id, errno, code));
      pty.close();
      this.pty = undefined;
      this.events?.onFailure(readFailure.summary);

      return;
    }

    if (code === undefined) {
      return;
    }

    this.exit = { code };
    this.progress = undefined;
    this.commandStartedAt = undefined;
    pty.close();
    this.pty = undefined;
    this.log?.debug("terminal exited", { terminal: this.id, code });
    this.events?.onExit(code);
  }

  private entryFor(client: string): AttachedClient {
    const entry = this.clients.get(client);

    if (entry === undefined) {
      throw new Error(`no client "${client}" is attached to terminal ${this.id}`);
    }

    return entry;
  }

  private viewports(): GridSize[] {
    const viewports: GridSize[] = [];

    for (const entry of this.clients.values()) {
      viewports.push(entry.viewport);
    }

    return viewports;
  }

  private applySize(size: GridSize): void {
    const emulator = this.emulator;
    const before = emulator?.size;
    emulator?.resize(size);

    const after = emulator?.size;

    if (after !== undefined && (after.columns !== before?.columns || after.rows !== before?.rows)) {
      for (const entry of this.clients.values()) {
        entry.owesSize = true;
      }
    }

    const pty = this.pty;

    if (pty === undefined) {
      return;
    }

    const resized = Result.try(() => {
      pty.resize({ columns: size.columns, rows: size.rows, ...NO_PIXEL_SIZE });
    });

    if (Result.isFailure(resized)) {
      const cause = resized.failure;
      const childIsGone =
        cause instanceof PseudoTerminalFailure && Predicate.isTagged(cause.detail, "notRunning");

      if (!childIsGone) {
        throw cause;
      }
    }
  }
}
