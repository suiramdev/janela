import type {
  GridSize,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  PseudoTerminalFailure,
  spawnPseudoTerminal,
  type PseudoTerminal,
  type PseudoTerminalConfiguration,
  type TerminalBytes,
} from "@janela/pty";
import { begin, type Logger, type Signpost } from "@janela/support";

import { createEmulator } from "./headless-emulator.ts";
import {
  DEFAULT_SCROLLBACK,
  type TerminalEmulating,
  type TerminalEventSink,
} from "./terminal-emulating.ts";

/** Shared, never mutated: an unstarted terminal owes every client nothing. */
const EMPTY = new Uint8Array(0);

/**
 * A live terminal: a PTY, a child process, and the authoritative screen.
 *
 * ## Why `LiveTerminal` and not `Terminal`
 *
 * Because `TerminalDescriptor` is the persistable one and this is the running
 * counterpart, and because emulator libraries export a `Terminal` of their own —
 * the collision would be resolved by whoever imported last.
 *
 * ## Where this runs
 *
 * **In the daemon, never in a client.** It owns the child process, so it outlives
 * every window; clients receive repaint sequences and render them. See
 * docs/decisions/0015-daemon-owned-sessions.md.
 *
 * ## Lazy by default
 *
 * Constructing one costs nothing — no PTY, no process, no emulator. `start()` is
 * what allocates, which is what makes 40 configured terminals viable and why
 * `idle` is a first-class `TerminalState`.
 */
export interface LiveTerminal {
  readonly id: TerminalID;
  readonly sessionID: SessionID;
  readonly descriptor: TerminalDescriptor;
  readonly state: TerminalState;

  /** Live title, following OSC 0/2. Falls back to the descriptor's title. */
  readonly displayTitle: string;

  /**
   * Working directory as last reported via OSC 7, when shell integration is
   * present. `undefined` means "we don't know", which is a normal state.
   */
  readonly reportedWorkingDirectory?: string;

  /** Spawns the process. Idempotent: calling it on a running terminal is a no-op. */
  start(): Promise<void>;

  /** Sends SIGHUP to the process group and tears down the PTY. */
  stop(): Promise<void>;

  /**
   * Restarts in place, keeping the terminal's identity and its place in the
   * session's layout.
   */
  restart(): Promise<void>;

  /**
   * User keyboard input, forwarded from a client.
   *
   * Goes straight to the PTY with no interpretation. Janela implements no key
   * bindings the terminal should own, and a client that pre-processes input has
   * made the same mistake one process further out. Note this is also how Ctrl-C
   * arrives — as the byte `0x03`, for the line discipline to interpret.
   */
  send(bytes: Uint8Array): void;

  /**
   * Registers or updates a client's viewport and returns the negotiated PTY size.
   *
   * Calling it again for a client already attached is how a resize arrives; there
   * is no separate `resize` for that reason.
   */
  attach(client: string, viewport: GridSize): GridSize;

  /** Returns the new negotiated size, or `undefined` when nobody is left attached. */
  detach(client: string): GridSize | undefined;

  /**
   * Drains the PTY once and feeds the emulator.
   *
   * Called once per frame by the daemon's frame loop for **every** live terminal,
   * attached or not: a detached terminal has to keep consuming or its child
   * blocks in `write(2)` at the high-water mark, and "your terminals survive the
   * window closing" would be a lie. This is also where a process exit and a lost
   * descriptor are observed, so a terminal nobody is watching still reaches
   * `exited`.
   */
  drain(): void;

  /**
   * The repaint one client is owed since its last one.
   *
   * Encode only — `drain()` is the feed, and it happens once per frame however
   * many clients are attached. N clients cost one drain and N encodes.
   */
  repaintFor(client: string): Uint8Array;

  /** The whole grid, for a client that has just attached. */
  fullRepaintFor(client: string): Uint8Array;

  /** Plain text, for `snapshotText`. */
  snapshotText(options: { readonly includeScrollback: boolean }): string;

  events: TerminalEventSink | undefined;
}

/**
 * The size the PTY is set to when several clients are attached.
 *
 * **The minimum of all attached viewports**, which is tmux's rule and the only one
 * that guarantees no attached client is shown a screen it cannot fit. A client
 * attaching with no viewport — the CLI, reading text — does not participate. See
 * docs/decisions/0016-daemon-protocol.md.
 *
 * Throws on an empty list rather than inventing an 80×24: "nobody is attached" is
 * `detach()` returning `undefined`, and a fabricated size here would resize a
 * running TUI to a screen no one asked for.
 */
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

export function createLiveTerminal(options: {
  readonly descriptor: TerminalDescriptor;
  readonly sessionID: SessionID;
  /** Resolved command, environment and working directory, decided by the caller. */
  readonly launch: TerminalLaunch;
  /** Lines of scrollback. Defaults to `DEFAULT_SCROLLBACK`. */
  readonly scrollback?: number;
  /**
   * Where shapes go: an id, an errno, an exit status. Absent means silent —
   * `@janela/support`'s `log()` is not implemented yet, and a library that
   * installs a sink during import decides the format for the whole process.
   */
  readonly log?: Logger;
  /**
   * The spawn seam. Production passes nothing. The read-failure test passes a
   * scripted terminal, because Darwin cannot produce one: a child exiting and
   * `revoke(2)` on the replica both make `read` return 0, which is EOF.
   */
  readonly spawn?: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
  /**
   * The emulator seam. Production passes nothing.
   *
   * It exists so a test can supply an encoder that sends *only* deltas, which is
   * what makes the size announcement decidable: today's `repaintSince` answers
   * any revision mismatch with a whole grid, so a resize would reach a client
   * even if nothing here tracked who had been told. #32's damage encoder removes
   * that accident, and the test using this seam is the constraint it must keep
   * passing.
   */
  readonly createEmulator?: (options: {
    readonly size: GridSize;
    readonly scrollback: number;
  }) => TerminalEmulating;
}): LiveTerminal {
  return new PtyLiveTerminal(options);
}

/**
 * The authoritative screen: a PTY, a child, and the emulator they feed.
 *
 * Two things this deliberately does not do, both tempting:
 *
 *   - **It does not drain per attached client.** One drain, one feed, N encodes.
 *     `drain()` is separate from `repaintFor()` for exactly that reason, and it
 *     runs for terminals nobody is watching.
 *   - **It does not treat a missing client revision as "everything".** A client's
 *     first frame is whatever changed since it attached; the whole grid is
 *     `fullRepaintFor`, explicitly. A sentinel here is how a routine frame
 *     becomes a full-screen redraw.
 */
class PtyLiveTerminal implements LiveTerminal {
  readonly id: TerminalID;
  readonly sessionID: SessionID;
  readonly descriptor: TerminalDescriptor;

  events: TerminalEventSink | undefined;

  /**
   * An optional *field*, not a property that may hold `undefined`:
   * `exactOptionalPropertyTypes` is on, so this is cleared with `delete`.
   */
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
  /** A `UserFacingError.summary`, so it is safe to put in front of a user. */
  private failure: string | undefined;
  private attention = false;
  /**
   * Per client: its viewport, the revision it has seen, and whether it still has
   * to be told the negotiated grid.
   *
   * `owesSize` is what makes the announcement survive an encoder that only ever
   * sends deltas: it forces the full path, which is the only thing that carries
   * `CSI 8 t`. A resize invalidates a client's whole screen anyway, so a delta
   * against the old geometry would be meaningless even if one existed.
   */
  private readonly clients = new Map<
    string,
    {
      viewport: GridSize;
      revision: number;
      owesSize: boolean;
      /** Open until this client's first full repaint is encoded. See `attach`. */
      attachMark?: Signpost;
    }
  >();

  /** Built once: the emulator is replaced on every start, the sink is not. */
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
    // Forwarded and nothing more. Whether a finished command deserves attention
    // depends on how long it ran and what is focused, and only a client knows
    // the second one — see docs/decisions/0006-agent-activity-signals.md.
    onPromptMark: (mark) => {
      this.events?.onPromptMark(mark);
    },
    onExit: () => {
      throw new Error("the emulator knows nothing about processes; drain() emits onExit");
    },
  };

  constructor(options: {
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
  }) {
    this.id = options.descriptor.id;
    this.sessionID = options.sessionID;
    this.descriptor = options.descriptor;
    this.launch = options.launch;
    this.scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
    this.log = options.log;
    this.spawn = options.spawn ?? spawnPseudoTerminal;
    this.makeEmulator = options.createEmulator ?? createEmulator;
  }

  /**
   * Derived, never stored: two sources of truth for the thing the sidebar is
   * judged on would be one too many.
   */
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
    return this.attention ? { kind: "needsAttention" } : { kind: "running" };
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
    this.title = undefined;
    delete this.reportedWorkingDirectory;
    this.emulator?.dispose();
    this.emulator = undefined;

    const size = this.clients.size > 0 ? negotiatedSize(this.viewports()) : this.launch.initialSize;

    try {
      // Before the emulator, so a spawn that fails allocates no grid.
      this.pty = this.spawn({
        executable: this.launch.executable,
        arguments: this.launch.arguments,
        workingDirectory: this.launch.workingDirectory,
        environment: this.launch.environment,
        initialSize: { columns: size.columns, rows: size.rows, pixelWidth: 0, pixelHeight: 0 },
      });
    } catch (error) {
      // Shown, not logged: the caller receives the same `UserFacingError` and the
      // state carries its summary for every client's mirror.
      if (error instanceof PseudoTerminalFailure) {
        this.failure = error.summary;
      }
      throw error;
    }

    this.emulator = this.makeEmulator({ size, scrollback: this.scrollback });
    this.emulator.events = this.emulatorSink;
    for (const entry of this.clients.values()) {
      entry.revision = this.emulator.revision;
    }
  }

  /**
   * Hangs up and returns. The state stays `running` until `drain()` observes the
   * reaped status, which is the truth: a child may ignore `SIGHUP`, and a code
   * invented here would be a code no process ever produced.
   */
  async stop(): Promise<void> {
    this.pty?.close();
  }

  async restart(): Promise<void> {
    // The old child's status is not awaited — its reader thread reaps it, and
    // `start()` clears the exit and failure it would have reported.
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

    let bytes: TerminalBytes | undefined;
    try {
      bytes = pty.drain();
    } catch (error) {
      if (!(error instanceof PseudoTerminalFailure) || error.detail.kind !== "readFailed") {
        throw error;
      }
      // Lost, not finished. No `onExit`: a client told the child exited would show
      // a status for a process whose fate nobody knows.
      const code = pty.exitCode();
      this.failure = error.summary;
      this.log?.warning("terminal read failed", {
        terminal: this.id,
        errno: error.detail.errno,
        ...(code === undefined ? {} : { code }),
      });
      pty.close();
      this.pty = undefined;
      return;
    }

    if (bytes === undefined) {
      const code = pty.exitCode();
      if (code === undefined) {
        // Gone but not yet reaped. The next frame asks again.
        return;
      }
      this.exit = { code };
      pty.close();
      this.pty = undefined;
      // The emulator is kept, so the last screen stays readable. It is disposed
      // by the next `start()`.
      this.log?.debug("terminal exited", { terminal: this.id, code });
      this.events?.onExit(code);
      return;
    }

    if (bytes.length > 0) {
      emulator.feed(bytes);
    }
  }

  send(bytes: Uint8Array): void {
    const pty = this.pty;
    if (pty === undefined) {
      throw new PseudoTerminalFailure({ kind: "notRunning" });
    }
    pty.write(bytes);
    // The one mechanical "the user has seen it" signal the daemon has. An explicit
    // clear can replace this when the protocol grows one.
    this.attention = false;
  }

  attach(client: string, viewport: GridSize): GridSize {
    const existing = this.clients.get(client);
    if (existing === undefined) {
      // A fresh client starts level with the emulator: attaching is not an
      // implicit full repaint, `fullRepaintFor` is the explicit one.
      this.clients.set(client, {
        viewport,
        revision: this.emulator?.revision ?? 0,
        owesSize: true,
        // The daemon's half of the attach budget in docs/performance.md: from the
        // request to the bytes that carry the screen. The client's half — those
        // bytes to a painted frame — is measured in the client.
        attachMark: begin("attach", this.id),
      });
    } else {
      existing.viewport = viewport;
    }
    const size = negotiatedSize(this.viewports());
    this.applySize(size);
    // An overruled vote is told again even though the negotiation did not move:
    // this client asked for a grid it is not getting, and nothing else would ever
    // correct it. Without this, a window resized while a smaller client holds the
    // minimum renders at its own width against the smaller PTY, permanently.
    const entry = this.clients.get(client);
    if (entry !== undefined && (size.columns !== viewport.columns || size.rows !== viewport.rows)) {
      entry.owesSize = true;
    }
    return size;
  }

  detach(client: string): GridSize | undefined {
    // A client that left before its first full repaint still closes the interval,
    // or the record would never be written at all.
    this.clients.get(client)?.attachMark?.end();
    this.clients.delete(client);
    if (this.clients.size === 0) {
      // The PTY keeps the size it had. Resizing a running TUI because the last
      // window closed would corrupt the screen the next client attaches to.
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
      // Nothing is painted and nothing is owed yet: the flag survives to the
      // first repaint after `start()`.
      return EMPTY;
    }
    if (entry.owesSize) {
      return this.fullRepaintFor(client);
    }
    // Once per frame per attached client, so the fields are built only when a
    // sink is installed — `begin` allocates nothing otherwise.
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
    // The whole grid states its own dimensions, so this discharges the debt.
    entry.owesSize = false;
    // Somebody is looking at the whole screen; they have seen whatever asked.
    this.attention = false;
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

  private entryFor(client: string): {
    viewport: GridSize;
    revision: number;
    owesSize: boolean;
    attachMark?: Signpost;
  } {
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

  /**
   * Sets the size everywhere it is held, and owes every attached client the news.
   *
   * The emulator is asked first because it is what `CSI 8 t` reports, and it is
   * the one that clamps.
   */
  private applySize(size: GridSize): void {
    const emulator = this.emulator;
    const before = emulator?.size;
    emulator?.resize(size);
    const after = emulator?.size;
    if (after !== undefined && (after.columns !== before?.columns || after.rows !== before?.rows)) {
      // Everyone, not just the client that caused it: the minimum is a fact about
      // the terminal, and the client that did not move is the one being letterboxed.
      for (const entry of this.clients.values()) entry.owesSize = true;
    }
    const pty = this.pty;
    if (pty === undefined) {
      return;
    }
    try {
      pty.resize({ columns: size.columns, rows: size.rows, pixelWidth: 0, pixelHeight: 0 });
    } catch (error) {
      // A resize landing on a child that died a frame ago is routine, not a fault:
      // the frame loop has not observed the exit yet.
      if (!(error instanceof PseudoTerminalFailure) || error.detail.kind !== "notRunning") {
        throw error;
      }
    }
  }
}

/**
 * What to run, fully resolved.
 *
 * `@janela/terminal` does not resolve a launch profile or build an environment —
 * that is `@janela/session`'s job, because it is the only place that knows about
 * projects, profiles and the user's shell. This package receives an answer.
 */
export interface TerminalLaunch {
  readonly executable: string;
  /** Full argv, including `argv[0]`. */
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: GridSize;
}
