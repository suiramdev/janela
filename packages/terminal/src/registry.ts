import type { SessionID, TerminalID, TerminalState } from "@janela/core";

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
  return new MapTerminalRegistry();
}

/**
 * A terminal is live when it holds a process.
 *
 * Local, and deliberately: `@janela/core`'s `isLive` is still unimplemented and
 * belongs to whoever owns that package's seams. Switch to it when it lands —
 * there must be one answer to this question, not two.
 */
function isLiveState(state: TerminalState): boolean {
  return state.kind === "running" || state.kind === "needsAttention";
}

class MapTerminalRegistry implements TerminalRegistry {
  private readonly terminals = new Map<TerminalID, LiveTerminal>();

  get(id: TerminalID): LiveTerminal | undefined {
    return this.terminals.get(id);
  }

  register(terminal: LiveTerminal): void {
    // A restart keeps a terminal's identity, so there is no legitimate second
    // registration — and replacing one silently would orphan a live child.
    if (this.terminals.has(terminal.id)) {
      throw new Error(`terminal ${terminal.id} is already registered`);
    }
    this.terminals.set(terminal.id, terminal);
  }

  remove(id: TerminalID): void {
    this.terminals.delete(id);
  }

  inSession(id: SessionID): readonly LiveTerminal[] {
    // A filter, not an index: the scale target is 40 terminals, and a second map
    // to keep in step is a bug surface bought with nothing.
    const found: LiveTerminal[] = [];
    for (const terminal of this.terminals.values()) {
      if (terminal.sessionID === id) {
        found.push(terminal);
      }
    }
    return found;
  }

  get liveCount(): number {
    let count = 0;
    for (const terminal of this.terminals.values()) {
      if (isLiveState(terminal.state)) {
        count += 1;
      }
    }
    return count;
  }

  async hangUpAll(): Promise<void> {
    // `stop()` on an idle or exited terminal is a no-op, so there is nothing to
    // filter and no state to consult first.
    await Promise.all([...this.terminals.values()].map((terminal) => terminal.stop()));
  }
}
