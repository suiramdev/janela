import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

export type SessionStatus = "attention" | "failed" | "done" | "working" | "running" | "idle";

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
  failed: "failed",
  done: "finished",
  working: "working",
  running: "running",
  idle: "idle",
} satisfies Record<SessionStatus, string>;

export function sessionStatus(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionStatus {
  let signalled = false;
  let done = false;
  let working = false;
  let running = false;
  let exited = false;

  for (const terminal of session.terminals) {
    const state = states[terminal.id];

    if (state === undefined) continue;

    if (state.kind === "needsAttention") {
      const activity = state.activity;

      if (activity === undefined || activity.kind === "waiting") return "attention";

      if (activity.kind === "working") working = true;
      else if (activity.outcome === "failed") signalled = true;
      else done = true;
    } else if (state.kind === "running") {
      if (state.progress === undefined && state.activity?.kind !== "working") running = true;
      else working = true;
    } else if (state.kind === "failed") exited = true;
    else if (state.kind === "exited" && state.code !== 0) exited = true;
  }

  if (signalled) return "failed";

  if (done) return "done";

  if (working) return "working";

  if (running) return "running";

  return exited ? "failed" : "idle";
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
