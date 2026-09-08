import type {
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";
import type { StateUpdate } from "@janela/protocol";

/**
 * The mirror a client renders.
 *
 * A mirror of daemon state, not an owner of it. These were main-thread-isolated
 * observable classes; here they are plain observable stores the view layer
 * subscribes to. The isolation rule that pinned them to a thread is gone — a WebView
 * has one — but the *ownership* rule it protected is unchanged, and that was the
 * only part that mattered.
 *
 * Note the split of ownership below: `sessions` is the daemon's, `selection` is not.
 */
export interface ProjectStore {
  readonly projects: readonly Project[];
  find(id: ProjectID): Project | undefined;
  subscribe(listener: () => void): () => void;
}

export interface SessionStore {
  readonly sessions: readonly Session[];

  /**
   * Purely local. Never sent to the daemon, never received from it.
   *
   * Selection is per-client state: two clients attached to the same daemon look at
   * different sessions, which is the entire point of being able to open Janela on a
   * phone while a Mac window is open.
   */
  selection: SessionID | undefined;

  /** Per-terminal status, as last reported. */
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;

  inProject(id: ProjectID): readonly Session[];
  readonly standaloneSessions: readonly Session[];

  /**
   * Whether a session has any live terminal.
   *
   * Derived from what the daemon reported, never inferred from what this client did.
   * A session whose terminals we have not heard about is not running as far as we
   * are concerned, and rendering it as running would be a lie we invented.
   */
  isRunning(id: SessionID): boolean;

  subscribe(listener: () => void): () => void;
}

/**
 * Applies a state update.
 *
 * The only way either collection ever changes. There is no local mutation path,
 * deliberately: "collapse this project" is a *request*, and the collapse renders
 * when the daemon confirms it.
 */
export interface MirrorApplying {
  apply(update: StateUpdate): void;
  /** Marks the mirror stale without discarding it. Called on disconnect. */
  markStale(): void;

  /**
   * True when the mirror predates the current connection.
   *
   * Held here rather than in the connection because staleness is a fact about the
   * *mirror*: a full snapshot is what clears it, and a full snapshot only ever
   * arrives here. `DaemonConnection.isStale` reads this one, so there is one
   * source and the reconnecting strip cannot disagree with what is on screen.
   * Starts true — an empty mirror predates every connection.
   */
  readonly isStale: boolean;

  /**
   * Whether any session in the mirror owns this terminal.
   *
   * The connection needs it to tell a *detach race* — output for a terminal the
   * mirror knows but nobody is watching, which is dropped — from a protocol
   * violation, which closes the connection (`unknownTerminal` in `frame.ts`).
   * The stores are the only place that knows which terminals exist, so the
   * question is answered here rather than by the connection keeping a second
   * table that could drift.
   */
  hasTerminal(id: TerminalID): boolean;
}

/**
 * Merges `incoming` into `existing` by id, preserving order.
 *
 * A partial update names only what changed, so an empty collection means
 * "unchanged" and returns the *same reference* — which is what lets a
 * `useSyncExternalStore` consumer skip a re-render without comparing contents.
 * An updated item keeps its position; a new one goes last, and the next full
 * snapshot restores the daemon's canonical order.
 *
 * Generic over `Project` and `Session` rather than written twice: the merge is a
 * property of "collection of things with ids", and two copies would be two places
 * for the order rule to drift.
 */
function mergeByID<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return existing;

  // Last duplicate wins, and the map's insertion order is the append order below.
  const byID = new Map<string, T>();
  for (const item of incoming) byID.set(item.id, item);

  const known = new Set<string>();
  const next = existing.map((item) => {
    known.add(item.id);
    return byID.get(item.id) ?? item;
  });
  for (const [id, item] of byID) {
    if (!known.has(id)) next.push(item);
  }
  return next;
}

/**
 * The session to select when a full snapshot proves the selected one is gone.
 *
 * The one *after* it in the old order, else the one before, else the first of
 * whatever is left. Dropping the user into an empty detail pane because a
 * different session was deleted is a bug they notice; so is jumping to the top of
 * the sidebar when the neighbour is right there.
 */
function neighbourOf(
  previous: readonly Session[],
  removedID: SessionID,
  next: readonly Session[],
): SessionID | undefined {
  const survives = (session: Session): boolean =>
    next.some((candidate) => candidate.id === session.id);

  const index = previous.findIndex((session) => session.id === removedID);
  if (index >= 0) {
    for (let after = index + 1; after < previous.length; after += 1) {
      const candidate = previous[after];
      if (candidate !== undefined && survives(candidate)) return candidate.id;
    }
    for (let before = index - 1; before >= 0; before -= 1) {
      const candidate = previous[before];
      if (candidate !== undefined && survives(candidate)) return candidate.id;
    }
  }
  return next[0]?.id;
}

/**
 * Mirrors `isLiveState` in `@janela/terminal`, which is daemon-side and therefore
 * unreachable from here. Both exist because `isLive` in `@janela/core` is still a
 * seam; when it lands, both call it.
 */
function isLiveState(state: TerminalState | undefined): boolean {
  return state !== undefined && (state.kind === "running" || state.kind === "needsAttention");
}

export function createStores(): {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly mirror: MirrorApplying;
} {
  let projects: readonly Project[] = [];
  let sessions: readonly Session[] = [];
  let terminalStates: Readonly<Record<TerminalID, TerminalState>> = {};
  let selection: SessionID | undefined;
  let stale = true;
  /** Recomputed only when `sessions` changes; the sidebar reads it every render. */
  let standalone: readonly Session[] = [];

  // One set for both stores: one `apply` is one notification, and a view that
  // reads sessions *and* projects must not see a half-applied update.
  const listeners = new Set<() => void>();

  const notify = (): void => {
    // `Set` iteration tolerates removal: a listener that unsubscribes itself
    // during the walk is simply not visited again.
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    projects: {
      get projects(): readonly Project[] {
        return projects;
      },
      find: (id) => projects.find((project) => project.id === id),
      subscribe,
    },

    sessions: {
      get sessions(): readonly Session[] {
        return sessions;
      },
      get selection(): SessionID | undefined {
        return selection;
      },
      set selection(next: SessionID | undefined) {
        if (selection === next) return;
        selection = next;
        notify();
      },
      get terminalStates(): Readonly<Record<TerminalID, TerminalState>> {
        return terminalStates;
      },
      inProject: (id) => sessions.filter((session) => session.projectID === id),
      get standaloneSessions(): readonly Session[] {
        return standalone;
      },
      isRunning(id: SessionID): boolean {
        const session = sessions.find((candidate) => candidate.id === id);
        if (session === undefined) return false;
        return session.terminals.some((terminal) => isLiveState(terminalStates[terminal.id]));
      },
      subscribe,
    },

    mirror: {
      apply(update: StateUpdate): void {
        const previous = sessions;

        if (update.isFullSnapshot) {
          projects = [...update.projects];
          sessions = [...update.sessions];
          // Replaced, not merged: a key absent from a full snapshot is a terminal
          // that no longer exists, and keeping its last state would render a dead
          // terminal as running.
          terminalStates = { ...update.terminalStates };

          if (selection !== undefined && !sessions.some((session) => session.id === selection)) {
            selection = neighbourOf(previous, selection, sessions);
          }
          stale = false;
        } else {
          projects = mergeByID(projects, update.projects);
          sessions = mergeByID(sessions, update.sessions);
          if (Object.keys(update.terminalStates).length > 0) {
            terminalStates = { ...terminalStates, ...update.terminalStates };
          }
          // Selection survives: the selected session may simply not have changed.
          // Only a full snapshot proves it is gone.
        }

        if (sessions !== previous) {
          standalone = sessions.filter((session) => session.projectID === undefined);
        }

        // Every apply notifies, even one that changed nothing: the references are
        // stable when nothing changed, so a consumer comparing them re-renders
        // nothing, and the alternative is a dirty-check on every field here.
        notify();
      },

      markStale(): void {
        stale = true;
        notify();
      },

      get isStale(): boolean {
        return stale;
      },

      hasTerminal(id: TerminalID): boolean {
        return sessions.some((session) => session.terminals.some((terminal) => terminal.id === id));
      },
    },
  };
}
