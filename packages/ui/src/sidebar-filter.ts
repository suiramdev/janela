import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

import { sessionStatus, type SessionStatus } from "./sidebar-model.ts";

/**
 * What the sidebar's filter control narrows the list to.
 *
 * Separate from both the row builder and the view: the row builder decides
 * *shape* (two levels, standalone first) and this decides *membership*, and
 * keeping them apart is what lets each be read on its own. The view holds the
 * filter as local state and nothing else.
 *
 * ## Why there is no text query here
 *
 * The sidebar used to carry a search field of its own. Finding a session by name
 * is the Command Menu's job now (`CommandPalette`) — one search surface, opened
 * from the sidebar's magnifier or ⌘⇧P, rather than a field that narrows this list
 * beside a palette that knows nothing about it.
 *
 * What is left is not a search: a status filter answers "what needs me?", which
 * is a question about state that no amount of typing answers.
 *
 * ## Why the order never changes
 *
 * Matching filters, and the order stays the one `sidebarRows` produced. This is a
 * permanent list a user *points at*, and re-ordering rows as terminal state
 * arrives would move the row under the cursor between the decision to click and
 * the click.
 */

/** Which sessions the list is narrowed to. `all` narrows nothing. */
export type SessionFilter = "all" | SessionStatus;

/** The filters, in the order the control offers them. */
export const SESSION_FILTERS: readonly SessionFilter[] = [
  "all",
  "attention",
  "running",
  "failed",
  "idle",
];

/** What each filter is called. The label travels with the value, never beside it. */
export const SESSION_FILTER_TITLE: Record<SessionFilter, string> = {
  all: "All Sessions",
  attention: "Needs Attention",
  running: "Running",
  failed: "Failed",
  idle: "Idle",
};

export interface FilteredSidebar {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  /**
   * Projects a narrowed list opens, whatever the user last collapsed.
   *
   * A filter that hides its own matches behind a collapsed row is a filter that
   * looks broken. These are merged *over* the local expansion overrides while a
   * filter is active, and forgotten when it is cleared — so collapsing a project,
   * filtering, and clearing the filter leaves it collapsed again.
   */
  readonly expansions: ReadonlyMap<ProjectID, boolean>;
}

const NOTHING_FORCED: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

/**
 * The projects and sessions that survive `filter`.
 *
 * Two rules:
 *
 * 1. A session survives if its status is the one asked for.
 * 2. A project survives if one of its sessions did. A project with nothing
 *    running is exactly what "running" was asked to hide — and unlike a name
 *    match, there is no sense in which the project itself qualifies.
 *
 * `all` returns the inputs unchanged — same arrays, no copy — because that is the
 * state the sidebar spends its life in.
 */
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

/**
 * The filter's expansions laid over the user's, for `sidebarRows`.
 *
 * The filter wins: it is the more recent of the two statements about what the
 * user wants to see.
 */
export function mergedExpansions(
  overrides: ReadonlyMap<ProjectID, boolean>,
  forced: ReadonlyMap<ProjectID, boolean>,
): ReadonlyMap<ProjectID, boolean> {
  if (forced.size === 0) return overrides;
  const merged = new Map(overrides);
  for (const [id, isExpanded] of forced) merged.set(id, isExpanded);
  return merged;
}
