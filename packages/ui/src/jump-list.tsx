import type {
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import { rankBy } from "./fuzzy.ts";
import { QuickList, type QuickListItem } from "./quick-list.tsx";
import { sessionStatus, statusText } from "./sidebar-model.ts";

/**
 * ⌘⇧O: every session, filtered as you type.
 *
 * The app's fastest path, and the reason the sidebar is not load-bearing. Three
 * letters and Enter must land in a session with the keyboard already in the right
 * pane — which is why picking one goes through `ViewState.focusTerminal` rather
 * than only setting the selection.
 */

const STANDALONE = "Standalone";

/** Ties break on recency: two equally good matches are ordered by where you were. */
const byRecency = (left: Session, right: Session): number =>
  Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);

/**
 * The sessions that match, best first.
 *
 * The haystack is `"<project> <session>"`, so `jan pt` finds `fix/pty` in `janela`
 * and not the identically-named session in another project. Ties break on recency,
 * because two equally good matches are ordered by which one you were last in.
 *
 * An empty query is the case the user sees most — the sheet opens before they type
 * — and it lists by recency with **the current session last**: Enter on an untouched
 * jump list should go to the most recent *other* session, which is the "back" that
 * a two-session workflow actually wants.
 */
export function rankedSessions(
  query: string,
  projects: readonly Project[],
  sessions: readonly Session[],
  currentSelection: SessionID | undefined,
): readonly Session[] {
  const nameOf = (id: ProjectID | undefined): string =>
    projects.find((project) => project.id === id)?.name ?? "";

  if (query.length === 0) {
    const ordered = sessions.toSorted(byRecency);
    const current = ordered.filter((session) => session.id === currentSelection);
    return [...ordered.filter((session) => session.id !== currentSelection), ...current];
  }

  return rankBy(
    query,
    sessions,
    (session) => `${nameOf(session.projectID)} ${session.name}`,
    byRecency,
  );
}

export interface JumpListProps {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly currentSelection: SessionID | undefined;
  readonly onPick: (sessionID: SessionID) => void;
  readonly onCancel: () => void;
}

export function JumpList(props: JumpListProps): ReactElement {
  const { projects, sessions, terminalStates, currentSelection, onPick, onCancel } = props;

  const rank = useCallback(
    (query: string): readonly QuickListItem[] =>
      rankedSessions(query, projects, sessions, currentSelection).map((session) => ({
        id: session.id,
        title: session.name,
        subtitle: projects.find((project) => project.id === session.projectID)?.name ?? STANDALONE,
        trailing: statusText(sessionStatus(session, terminalStates)),
      })),
    [projects, sessions, terminalStates, currentSelection],
  );

  const pick = useCallback(
    (id: string) => {
      onPick(id as SessionID);
    },
    [onPick],
  );

  const emptyText = useMemo(
    () => (sessions.length === 0 ? "No sessions yet." : "No session matches."),
    [sessions.length],
  );

  return (
    <QuickList
      label="Sessions"
      placeholder="Go to session…"
      rank={rank}
      onPick={pick}
      onCancel={onCancel}
      emptyText={emptyText}
    />
  );
}
