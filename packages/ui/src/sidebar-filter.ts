import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

import { fuzzyScore } from "./fuzzy.ts";
import { sessionStatus, type SessionStatus } from "./sidebar-model.ts";

/**
 * What the sidebar's search field and filter control narrow the list to.
 *
 * Separate from both the row builder and the view: the row builder decides
 * *shape* (two levels, standalone first) and this decides *membership*, and
 * keeping them apart is what lets each be read on its own. The view holds the
 * query as local state and nothing else.
 *
 * ## Why the order never changes
 *
 * `fuzzyScore` is the same matcher the jump list and the command palette use, so
 * `jan pt` finds `fix/pty` in `janela` here too. What is deliberately *not*
 * shared is the ranking: those two are transient lists a user reads top-down,
 * and this is a permanent list a user points at. Re-sorting rows by score as
 * characters arrive moves the row under the cursor between the decision to click
 * and the click. So matching filters, and the order stays the one
 * `sidebarRows` produced.
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

export interface SidebarQuery {
  /** What the user typed. Matched against session names and project names. */
  readonly text: string;
  readonly filter: SessionFilter;
}

/** The query that shows everything, and the state the sidebar opens in. */
export const EVERYTHING: SidebarQuery = { text: "", filter: "all" };

/** Whether the query narrows anything, which is what makes the clear button appear. */
export function isNarrowed(query: SidebarQuery): boolean {
  return query.text.trim().length > 0 || query.filter !== "all";
}

export interface FilteredSidebar {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  /**
   * Projects a narrowed query opens, whatever the user last collapsed.
   *
   * A search that hides its own matches behind a collapsed row is a search that
   * looks broken. These are merged *over* the local expansion overrides while a
   * query is active, and forgotten when it is cleared — so collapsing a project,
   * searching, and clearing the search leaves it collapsed again.
   */
  readonly expansions: ReadonlyMap<ProjectID, boolean>;
}

const NOTHING_FORCED: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

/**
 * The projects and sessions that survive `query`.
 *
 * Three rules, and the first is the one worth knowing:
 *
 * 1. **A project whose own name matches keeps all of its sessions.** Typing a
 *    project's name is asking to see the project, not to see which of its
 *    sessions happen to share its name.
 * 2. A project no session survived is dropped — unless its own name matched.
 *    A project with nothing needing attention is exactly what "needs attention"
 *    is asking to hide; a project you typed the name of is one you want to see,
 *    empty or not, because that is where "new session here" lives.
 * 3. A standalone session is matched on its own name. It has no project to
 *    inherit a match from.
 *
 * An empty, unfiltered query returns the inputs unchanged — same arrays, no copy
 * — because that is the state the sidebar spends its life in.
 */
export function filterSidebar(
  query: SidebarQuery,
  projects: readonly Project[],
  sessions: readonly Session[],
  states: Readonly<Record<TerminalID, TerminalState>>,
): FilteredSidebar {
  if (!isNarrowed(query)) {
    return { projects, sessions, expansions: NOTHING_FORCED };
  }

  const text = query.text.trim();
  // An empty query matches everything with score 0, which is right for sessions
  // — a status filter alone should not hide any of them — and wrong for
  // projects: it would keep every project on screen while "needs attention" is
  // on, which is the one thing that filter exists to stop.
  const isSearching = text.length > 0;
  const matchedProjects = new Set<ProjectID>();
  if (isSearching) {
    for (const project of projects) {
      if (fuzzyScore(text, project.name) !== undefined) matchedProjects.add(project.id);
    }
  }

  const keptSessions: Session[] = [];
  const expansions = new Map<ProjectID, boolean>();
  for (const session of sessions) {
    if (query.filter !== "all" && sessionStatus(session, states) !== query.filter) continue;

    const inMatchedProject =
      session.projectID !== undefined && matchedProjects.has(session.projectID);
    if (!inMatchedProject && fuzzyScore(text, session.name) === undefined) continue;

    keptSessions.push(session);
    if (session.projectID !== undefined) expansions.set(session.projectID, true);
  }

  const keptProjects = projects.filter(
    (project) => matchedProjects.has(project.id) || expansions.has(project.id),
  );

  return { projects: keptProjects, sessions: keptSessions, expansions };
}

/**
 * The query's expansions laid over the user's, for `sidebarRows`.
 *
 * The query wins: it is the more recent of the two statements about what the user
 * wants to see.
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
