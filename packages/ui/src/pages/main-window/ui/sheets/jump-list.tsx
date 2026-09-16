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

import { rankBy } from "../../../../shared/lib/fuzzy-match/index.ts";
import { type FindRow, FindSurface } from "../../../../shared/ui/index.ts";
import { sessionStatus, statusText } from "../../model/session-rows.ts";

export interface JumpListProps {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly currentSelection: SessionID | undefined;
  readonly onPick: (sessionID: SessionID) => void;
  readonly onCancel: () => void;
}

const STANDALONE = "Standalone";

const byRecency = (left: Session, right: Session): number =>
  Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);

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

export function JumpList(props: JumpListProps): ReactElement {
  const { projects, sessions, terminalStates, currentSelection, onPick, onCancel } = props;

  const rank = useCallback(
    (query: string): readonly FindRow[] =>
      rankedSessions(query, projects, sessions, currentSelection).map((session) => ({
        value: session.id,
        label: session.name,
        description:
          projects.find((project) => project.id === session.projectID)?.name ?? STANDALONE,
        status: statusText(sessionStatus(session, terminalStates)),
      })),
    [projects, sessions, terminalStates, currentSelection],
  );

  const pick = useCallback(
    (id: string) => {
      const session = sessions.find((candidate) => candidate.id === id);

      if (session !== undefined) onPick(session.id);
    },
    [onPick, sessions],
  );

  const emptyText = useMemo(
    () => (sessions.length === 0 ? "No sessions yet." : "No session matches."),
    [sessions.length],
  );

  return (
    <FindSurface
      label="Sessions"
      placeholder="Go to session…"
      rank={rank}
      onPick={pick}
      onCancel={onCancel}
      emptyText={emptyText}
    />
  );
}
