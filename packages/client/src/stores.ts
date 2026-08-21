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
}

export function createStores(): {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly mirror: MirrorApplying;
} {
  throw new Error(`not implemented: createStores`);
}

// TODO: ProjectStore.apply() — on a full snapshot, replace. On a partial update,
// merge by id, preserving order. A partial update names only what changed.

// TODO: SessionStore.apply() — merge by id, and keep `selection` even when the
// selected session is absent from a partial update: it may simply not have changed.
// Clear it only when a full snapshot proves the session is gone, and then pick a
// neighbour rather than nothing, because dropping the user into an empty detail
// pane because a *different* session was deleted is a bug they will notice.
