import type {
  LaunchProfile,
  LaunchProfileAvailability,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";
import type { StateUpdate } from "@janela/protocol";

export interface ProjectStore {
  readonly projects: readonly Project[];
  find(id: ProjectID): Project | undefined;
  subscribe(listener: () => void): () => void;
}

export interface SessionStore {
  readonly sessions: readonly Session[];

  selection: SessionID | undefined;

  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;

  inProject(id: ProjectID): readonly Session[];
  readonly standaloneSessions: readonly Session[];

  readonly launchProfiles: readonly LaunchProfile[];

  readonly launchProfileAvailability: LaunchProfileAvailability;

  isRunning(id: SessionID): boolean;

  subscribe(listener: () => void): () => void;
}

export interface Stores {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly mirror: MirrorApplying;
}

export interface MirrorApplying {
  apply(update: StateUpdate): void;
  markStale(): void;

  readonly isStale: boolean;

  hasTerminal(id: TerminalID): boolean;
}

function mergeByID<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return existing;

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

function mostRecentlyActive(candidates: readonly Session[]): SessionID | undefined {
  let best: Session | undefined;

  for (const candidate of candidates) {
    if (best === undefined || candidate.lastActiveAt > best.lastActiveAt) best = candidate;
  }

  return best?.id;
}

function isLiveState(state: TerminalState | undefined): boolean {
  return state !== undefined && (state.kind === "running" || state.kind === "needsAttention");
}

export function createStores(): Stores {
  let projects: readonly Project[] = [];
  let sessions: readonly Session[] = [];
  let terminalStates: StateUpdate["terminalStates"] = {};
  let launchProfiles: readonly LaunchProfile[] = [];
  let launchProfileAvailability: LaunchProfileAvailability = {};
  let selection: SessionID | undefined;
  let stale = true;
  let standalone: readonly Session[] = [];

  const listeners = new Set<() => void>();

  const notify = (): void => {
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
      get launchProfiles(): readonly LaunchProfile[] {
        return launchProfiles;
      },
      get launchProfileAvailability(): LaunchProfileAvailability {
        return launchProfileAvailability;
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
          terminalStates = { ...update.terminalStates };
          launchProfiles = [...update.launchProfiles];
          launchProfileAvailability = { ...update.launchProfileAvailability };

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

          if (update.launchProfiles.length > 0) {
            launchProfiles = mergeByID(launchProfiles, update.launchProfiles);
          }

          if (Object.keys(update.launchProfileAvailability).length > 0) {
            launchProfileAvailability = {
              ...launchProfileAvailability,
              ...update.launchProfileAvailability,
            };
          }
        }

        if (selection === undefined) selection = mostRecentlyActive(sessions);

        if (sessions !== previous) {
          standalone = sessions.filter((session) => session.projectID === undefined);
        }

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
