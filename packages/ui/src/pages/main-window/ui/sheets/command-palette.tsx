import type { Project, Session, SessionID, TerminalID, TerminalState } from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import {
  COMMANDS,
  type CommandID,
  acceleratorCaps,
  isCommandID,
} from "../../../../shared/config/index.ts";
import { rankBy } from "../../../../shared/lib/fuzzy-match/index.ts";
import { type FindRow, FindSurface } from "../../../../shared/ui/index.ts";
import { sessionStatus, statusText } from "../../model/session-rows.ts";

export interface CommandPaletteProps {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly onPick: (id: CommandID) => void;
  readonly onPickSession: (id: SessionID) => void;
  readonly onCancel: () => void;
}

const STANDALONE = "Standalone";

const COMMANDS_GROUP = "Commands";

const SESSIONS_GROUP = "Sessions";

function sessionRowID(id: SessionID): string {
  return `session:${id}`;
}

export function rankedCommands(query: string): readonly FindRow[] {
  const ranked =
    query.length === 0
      ? COMMANDS
      : rankBy(
          query,
          COMMANDS,
          (command) => command.title,
          () => 0,
        );

  return ranked.map((command) => {
    const row: FindRow = { value: command.id, label: command.title, group: COMMANDS_GROUP };

    if (command.accelerator !== undefined) row.shortcut = acceleratorCaps(command.accelerator);

    return row;
  });
}

export function rankedSessionRows(
  query: string,
  projects: readonly Project[],
  sessions: readonly Session[],
  terminalStates: Readonly<Record<TerminalID, TerminalState>>,
): readonly FindRow[] {
  if (query.length === 0) return [];

  const nameOf = (session: Session): string =>
    projects.find((project) => project.id === session.projectID)?.name ?? "";

  return rankBy(
    query,
    sessions,
    (session) => `${nameOf(session)} ${session.name}`,
    () => 0,
  ).map((session) => {
    const project = nameOf(session);

    return {
      value: sessionRowID(session.id),
      label: session.name,
      description: project === "" ? STANDALONE : project,
      group: SESSIONS_GROUP,
      status: statusText(sessionStatus(session, terminalStates)),
    };
  });
}

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const { projects, sessions, terminalStates, onPick, onPickSession, onCancel } = props;

  const rank = useCallback(
    (query: string): readonly FindRow[] => [
      ...rankedCommands(query),
      ...rankedSessionRows(query, projects, sessions, terminalStates),
    ],
    [projects, sessions, terminalStates],
  );

  const pick = useCallback(
    (id: string) => {
      const session = sessions.find((candidate) => sessionRowID(candidate.id) === id);

      if (session !== undefined) {
        onPickSession(session.id);

        return;
      }

      if (isCommandID(id)) onPick(id);
    },
    [onPick, onPickSession, sessions],
  );

  const emptyText = useMemo(
    () => (sessions.length === 0 ? "No command matches." : "No command or session matches."),
    [sessions.length],
  );

  return (
    <FindSurface
      label="Commands"
      placeholder="Search sessions, or run a command…"
      rank={rank}
      onPick={pick}
      onCancel={onCancel}
      emptyText={emptyText}
    />
  );
}
