import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

import { type SessionStatus, sessionStatus } from "./session-rows.ts";

export type SessionFilter = "all" | SessionStatus;

export interface FilteredSidebar {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly expansions: ReadonlyMap<ProjectID, boolean>;
}

export const SESSION_FILTERS: readonly SessionFilter[] = [
  "all",
  "attention",
  "working",
  "running",
  "failed",
  "idle",
];

export const SESSION_FILTER_TITLE = {
  all: "All Sessions",
  attention: "Needs Attention",
  working: "Working",
  running: "Running",
  failed: "Failed",
  idle: "Idle",
} satisfies Record<SessionFilter, string>;

const NOTHING_FORCED: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

export function filterSidebar(
  filter: SessionFilter,
  projects: readonly Project[],
  sessions: readonly Session[],
  states: Readonly<Record<TerminalID, TerminalState>>,
): FilteredSidebar {
  if (filter === "all") {
    return { projects, sessions, expansions: NOTHING_FORCED };
  }

  const keptSessions: Session[] = [];
  const expansions = new Map<ProjectID, boolean>();

  for (const session of sessions) {
    if (sessionStatus(session, states) !== filter) continue;

    keptSessions.push(session);

    if (session.projectID !== undefined) expansions.set(session.projectID, true);
  }

  const keptProjects = projects.filter((project) => expansions.has(project.id));

  return { projects: keptProjects, sessions: keptSessions, expansions };
}

export function mergedExpansions(
  overrides: ReadonlyMap<ProjectID, boolean>,
  forced: ReadonlyMap<ProjectID, boolean>,
): ReadonlyMap<ProjectID, boolean> {
  if (forced.size === 0) return overrides;

  const merged = new Map(overrides);

  for (const [id, isExpanded] of forced) merged.set(id, isExpanded);

  return merged;
}
