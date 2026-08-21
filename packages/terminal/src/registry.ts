import type { SessionID, TerminalID } from "@janela/core";

import type { LiveTerminal } from "./live-terminal.ts";

/**
 * Every live terminal in the daemon, keyed by id.
 *
 * Single source of truth for "what is running". The session layer asks before it
 * lets a worktree be removed, and the daemon asks before deciding it may exit.
 */
export interface TerminalRegistry {
  get(id: TerminalID): LiveTerminal | undefined;
  register(terminal: LiveTerminal): void;
  remove(id: TerminalID): void;

  /**
   * Terminals belonging to a session, across every tab and split.
   *
   * This is what makes a session's status derived rather than stored, and what
   * "closing a session kills its terminals" means — including panes no client ever
   * attached to.
   */
  inSession(id: SessionID): readonly LiveTerminal[];

  /**
   * How many terminals hold a live process.
   *
   * The daemon's idle-exit rule depends on this: a daemon with live terminals stays
   * even with no clients connected. That asymmetry is the entire feature.
   */
  readonly liveCount: number;

  /**
   * Hangs up every terminal.
   *
   * Called on SIGTERM at logout, and on an explicit "Stop Background Service".
   * Never called because a client disconnected — see non-negotiable #7.
   */
  hangUpAll(): Promise<void>;
}

export function createTerminalRegistry(): TerminalRegistry {
  throw new Error(`not implemented: createTerminalRegistry`);
}
