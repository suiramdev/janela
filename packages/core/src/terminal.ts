import type { AbsolutePath, Instant, LaunchProfileID, TerminalID } from "./identifiers.ts";
import type { AutomationEvent } from "./project.ts";

/**
 * The *persistable* description of a terminal.
 *
 * This is not the live terminal — that is `LiveTerminal` in `@janela/terminal`,
 * which holds a file descriptor, a child process and an emulator. This type is
 * the part we can write to disk, diff, and restore at launch. Keeping the two
 * separate is what lets `@janela/core` stay free of I/O, and it is what makes
 * "restore my layout" mean "restore descriptors" rather than "restart everyone's
 * shells".
 */
export interface TerminalDescriptor {
  readonly id: TerminalID;

  /**
   * Tab title. Starts from the launch profile's name, then follows the terminal's
   * OSC 0/2 title sequences once the process starts talking.
   */
  title: string;

  /** What to run. Absent means the user's login shell. */
  profileID?: LaunchProfileID;

  /**
   * Working directory override. Defaults to the session directory when absent.
   * Set when the user splits a terminal while `cd`'d somewhere else.
   */
  workingDirectoryOverride?: AbsolutePath;

  /**
   * Whether Janela should start this terminal automatically when the session is
   * opened. Typically true for the first terminal only; the rest are lazy.
   */
  startsAutomatically: boolean;

  /** Why this terminal exists. */
  role: TerminalRole;

  createdAt: Instant;
}

/**
 * Why a terminal exists.
 *
 * Automation terminals are ordinary terminals with a label. They are not a hidden
 * process with a bespoke output view: everything Janela runs on the user's behalf
 * runs somewhere they can watch it, scroll it, and Ctrl-C it.
 */
export type TerminalRole =
  /** The user asked for it. */
  | { readonly kind: "user" }
  /** A project automation command runs here. */
  | { readonly kind: "automation"; readonly event: AutomationEvent };

/**
 * Coarse lifecycle state of a live terminal, as the UI needs to render it.
 *
 * Note what is absent: there is no `waitingForUser` or `agentThinking`. Janela
 * does not attempt to parse agent semantics out of a byte stream. It reports what
 * the *terminal* told it (OSC 9 / OSC 777 notifications, OSC 133 prompt marks,
 * BEL) and nothing more.
 *
 * A *session's* status is derived from its terminals rather than stored. Two
 * sources of truth for the thing the sidebar is judged on would be one too many.
 *
 * This crosses the socket: the daemon computes it and pushes it, and clients
 * render what they were told rather than inferring it from what they themselves
 * did.
 */
export type TerminalState =
  /**
   * Configured but no process spawned yet. Costs nothing; this is how we keep 40
   * open terminals cheap.
   */
  | { readonly kind: "idle" }
  /** Child process is running. */
  | { readonly kind: "running" }
  /**
   * The terminal emitted an attention signal (BEL, OSC 9, or an OSC 133 prompt
   * mark following a long-running command) and is not focused.
   */
  | { readonly kind: "needsAttention" }
  /** Process exited. Carries the status so the UI can distinguish 0 from 130. */
  | { readonly kind: "exited"; readonly code: number }
  /** Spawn failed. The associated message is safe to show a user. */
  | { readonly kind: "failed"; readonly message: string };

export function isLive(state: TerminalState): boolean {
  return state.kind === "running" || state.kind === "needsAttention";
}

/**
 * A terminal's size in cells.
 *
 * Cells, not pixels. Pixel metrics are a client fact and do not survive multiple
 * clients on different displays.
 */
export interface GridSize {
  readonly columns: number;
  readonly rows: number;
}
