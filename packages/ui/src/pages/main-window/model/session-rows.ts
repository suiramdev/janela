import {
  isLive,
  type AgentActivity,
  type Project,
  type ProjectID,
  type Session,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { Match } from "effect";

export type SessionStatus = "error" | "running" | "unread" | "idle";

export type SessionMark = "read" | "unread" | "none";

export interface SessionRow {
  readonly session: Session;
  readonly status: SessionStatus;
  readonly mark: SessionMark;
}

export type SidebarRow =
  | ({ readonly kind: "session" } & SessionRow)
  | {
      readonly kind: "project";
      readonly project: Project;
      readonly isExpanded: boolean;
      readonly sessions: readonly SessionRow[];
    };

const STATUS_TEXT = {
  error: "stopped with an error",
  running: "running",
  unread: "unread",
  idle: "idle",
} satisfies Record<SessionStatus, string>;

function activityStatus(activity: AgentActivity | undefined, unseen: boolean): SessionStatus {
  if (activity === undefined) return unseen ? "unread" : "idle";

  return Match.value(activity).pipe(
    Match.when({ kind: "working" }, (): SessionStatus => "running"),
    Match.when({ kind: "finished", outcome: "failed" }, (): SessionStatus => "error"),
    Match.orElse((): SessionStatus => (unseen ? "unread" : "idle")),
  );
}

function terminalStatus(state: TerminalState): SessionStatus {
  return Match.value(state).pipe(
    Match.when({ kind: "idle" }, (): SessionStatus => "idle"),
    Match.when({ kind: "failed" }, (): SessionStatus => "error"),
    Match.when({ kind: "exited" }, (exited): SessionStatus =>
      exited.code === 0 ? "idle" : "error",
    ),
    Match.when({ kind: "needsAttention" }, (attention) => activityStatus(attention.activity, true)),
    Match.when({ kind: "running" }, (running): SessionStatus => {
      const status = activityStatus(running.activity, false);

      return status === "idle" && running.progress !== undefined ? "running" : status;
    }),
    Match.exhaustive,
  );
}

export function sessionStatus(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionStatus {
  let running = false;
  let unread = false;

  for (const terminal of session.terminals) {
    const state = states[terminal.id];

    if (state === undefined) continue;

    const status = terminalStatus(state);

    if (status === "error") return "error";

    if (status === "running") running = true;
    else if (status === "unread") unread = true;
  }

  if (running) return "running";

  return unread ? "unread" : "idle";
}

export function sessionMark(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionMark {
  const status = sessionStatus(session, states);

  if (status === "unread") return "read";

  if (status !== "idle") return "none";

  const live = session.terminals.some((terminal) => {
    const state = states[terminal.id];

    return state !== undefined && isLive(state);
  });

  return live ? "unread" : "none";
}

function sessionRow(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionRow {
  return { session, status: sessionStatus(session, states), mark: sessionMark(session, states) };
}

export function sidebarRows(
  projects: readonly Project[],
  sessions: readonly Session[],
  states: Readonly<Record<TerminalID, TerminalState>>,
  expansionOverrides: ReadonlyMap<ProjectID, boolean>,
): readonly SidebarRow[] {
  const rows: SidebarRow[] = [];

  for (const session of sessions) {
    if (session.projectID === undefined) {
      rows.push({ kind: "session", ...sessionRow(session, states) });
    }
  }

  for (const project of projects) {
    rows.push({
      kind: "project",
      project,
      isExpanded: expansionOverrides.get(project.id) ?? project.isExpanded,
      sessions: sessions
        .filter((session) => session.projectID === project.id)
        .map((session) => sessionRow(session, states)),
    });
  }

  return rows;
}

export function statusText(status: SessionStatus): string {
  return STATUS_TEXT[status];
}
