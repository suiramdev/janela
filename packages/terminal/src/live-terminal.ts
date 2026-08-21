import type {
  GridSize,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";

import type { TerminalEventSink } from "./terminal-emulating.ts";

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

  /** Registers a client's viewport and returns the resulting PTY size. */
  attach(client: string, viewport: GridSize): GridSize;

  /** Returns the new negotiated size, or `undefined` when nobody is left attached. */
  detach(client: string): GridSize | undefined;

  /**
   * Drains the PTY, feeds the emulator, and returns the repaint for one client.
   *
   * Called once per frame per attached client by the daemon's frame loop. The drain
   * happens once regardless of how many clients are attached; only the encode is
   * per client.
   */
  repaintFor(client: string): Uint8Array;

  /** The whole grid, for a client that has just attached. */
  fullRepaintFor(client: string): Uint8Array;

  /** Plain text, for `snapshotText`. */
  snapshotText(options: { readonly includeScrollback: boolean }): string;

  events: TerminalEventSink | undefined;
}

// TODO: The authoritative grid. Feed drained PTY bytes to the headless emulator,
// track damage, and expose the two encoders:
//
//   - `repaintFor(client)` — minimal escape sequences for what changed since that
//     client's last revision, called once per frame per attached client.
//   - `fullRepaintFor(client)` — the whole grid as escape sequences, sent on
//     attach. This is what makes reattaching correct rather than lucky.
//
// Both are the hard part of docs/decisions/0015-daemon-owned-sessions.md, and a
// correct-but-dumb full repaint every frame is a valid first implementation —
// deliberately, because it means the optimisation can only make us slow, never
// wrong.
//
// Test with two emulators: feed bytes to one, encode the damage, feed the result
// to a second, and assert the two grids are identical. The migration spike did
// exactly this and it works, including for a full-screen alternate-screen TUI with
// the cursor left mid-screen. See docs/testing.md.
//
// Two things not to do, both tempting:
//   - Do not drain the PTY once per attached client. One drain, one feed, N encodes.
//   - Do not let a client's revision be `undefined` meaning "everything". Attach
//     is an explicit full repaint; a sentinel here is how a routine frame
//     accidentally becomes a full-screen redraw.

/**
 * The size the PTY is set to when several clients are attached.
 *
 * **The minimum of all attached viewports**, which is tmux's rule and the only one
 * that guarantees no attached client is shown a screen it cannot fit. A client
 * attaching with no viewport — the CLI, reading text — does not participate. See
 * docs/decisions/0016-daemon-protocol.md.
 */
export function negotiatedSize(viewports: readonly GridSize[]): GridSize {
  void viewports;
  throw new Error(`not implemented: negotiatedSize`);
}

export function createLiveTerminal(options: {
  readonly descriptor: TerminalDescriptor;
  readonly sessionID: SessionID;
  /** Resolved command, environment and working directory, decided by the caller. */
  readonly launch: TerminalLaunch;
}): LiveTerminal {
  void options;
  throw new Error(`not implemented: createLiveTerminal`);
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
