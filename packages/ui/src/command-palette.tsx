import type { Project, Session, SessionID, TerminalID, TerminalState } from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import { acceleratorCaps, COMMANDS, isCommandID, type CommandID } from "./commands.ts";
import { FindSurface, type FindRow } from "./find-surface.tsx";
import { rankBy } from "./fuzzy.ts";
import { sessionStatus, statusText } from "./sidebar-model.ts";

/**
 * ⌘⇧P, and the sidebar's magnifier: everything the app can do, by name.
 *
 * It reads `COMMANDS` — the same table the native menu is built from — so a row
 * added there appears here, in the menu bar, and nowhere else that has to be kept
 * in step.
 *
 * ## Why sessions are in here too
 *
 * This is the window's **one search surface**. The sidebar used to carry a field
 * that narrowed its own list, which meant a user who typed a session's name got a
 * different answer depending on which box they typed it into. Typing here finds
 * the session as well as the command, so the sidebar can be what it is for:
 * a list you point at.
 *
 * Commands come first and sessions follow, because an empty query lists the
 * command table — that is what ⌘⇧P promises — and a session name is something the
 * user is part-way through typing when it appears.
 *
 * `JumpList` is still its own sheet (⌘⇧O): it opens *already ordered by recency*
 * with the current session last, which is the "back" a two-session workflow
 * wants, and no ranking over a mixed list can offer that.
 */

const STANDALONE = "Standalone";

/**
 * The two headings.
 *
 * Named groups rather than one flat list: the palette answers two questions at
 * once, and a session row and a command row are told apart by where they are
 * listed rather than by the user noticing that one has keycaps.
 */
const COMMANDS_GROUP = "Commands";
const SESSIONS_GROUP = "Sessions";

/**
 * A session's row id.
 *
 * Namespaced because one list holds two kinds of row and the menu speaks in
 * values: without the prefix, a session named `nextTab` would run a command. The
 * reverse lookup goes through the session list rather than stripping the prefix
 * and asserting — nothing here has to invent a `SessionID`.
 */
function sessionRowID(id: SessionID): string {
  return `session:${id}`;
}

/** The commands that match, best first. An empty query keeps the table's order. */
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

  return ranked.map((command) => ({
    value: command.id,
    label: command.title,
    group: COMMANDS_GROUP,
    // Pre-formatted caps: `acceleratorCaps` already speaks in ⌘⇧ glyphs, and
    // the menu draws one cap per glyph when it is handed those rather than a
    // `"mod+d"` combo to translate.
    ...(command.accelerator === undefined
      ? {}
      : { shortcut: acceleratorCaps(command.accelerator) }),
  }));
}

/**
 * The sessions that match, best first — none for an empty query.
 *
 * The haystack is `"<project> <session>"`, exactly as the jump list's is, so
 * `jan pt` finds `fix/pty` in `janela` here as well. Ties keep the mirror's
 * order; recency is the jump list's tie-break and belongs to the surface that
 * opens on it.
 */
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

export interface CommandPaletteProps {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly onPick: (id: CommandID) => void;
  readonly onPickSession: (id: SessionID) => void;
  readonly onCancel: () => void;
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
      // The remaining rows come from the table, so this cannot fail — and
      // narrowing here rather than asserting is what keeps `CommandID` meaning
      // something.
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
