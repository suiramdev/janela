import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

export type SessionStatus = "attention" | "running" | "failed" | "idle";

export type SidebarRow =
  | {
      readonly kind: "session";
      readonly session: Session;
      readonly status: SessionStatus;
      readonly indented: boolean;
    }
  | { readonly kind: "project"; readonly project: Project; readonly isExpanded: boolean };

const STATUS_TEXT = {
  attention: "needs attention",
  running: "running",
  failed: "failed",
  idle: "idle",
} satisfies Record<SessionStatus, string>;

export function sessionStatus(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionStatus {
  let running = false;
  let failed = false;

  for (const terminal of session.terminals) {
    const state = states[terminal.id];

    if (state === undefined) continue;

    if (state.kind === "needsAttention") return "attention";

    if (state.kind === "running") running = true;
    else if (state.kind === "failed") failed = true;
    else if (state.kind === "exited" && state.code !== 0) failed = true;
  }

  if (running) return "running";

  return failed ? "failed" : "idle";
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
      rows.push({
        kind: "session",
        session,
        status: sessionStatus(session, states),
        indented: false,
      });
    }
  }

  for (const project of projects) {
    const isExpanded = expansionOverrides.get(project.id) ?? project.isExpanded;
    rows.push({ kind: "project", project, isExpanded });

    if (!isExpanded) continue;

    for (const session of sessions) {
      if (session.projectID === project.id) {
        rows.push({
          kind: "session",
          session,
          status: sessionStatus(session, states),
          indented: true,
        });
      }
    }
  }

  return rows;
}

export function statusText(status: SessionStatus): string {
  return STATUS_TEXT[status];
}
