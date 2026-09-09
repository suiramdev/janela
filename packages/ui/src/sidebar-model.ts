import type { Project, ProjectID, Session, TerminalID, TerminalState } from "@janela/core";

/**
 * What the sidebar shows, derived from the mirror.
 *
 * Separate from the view that renders it so the jump list can ask a session for its
 * status without importing a window — and so the two never disagree about what
 * "running" means.
 */

/** What a session row shows, in precedence order. */
export type SessionStatus = "attention" | "running" | "failed" | "idle";

/**
 * One row of the sidebar, flat.
 *
 * A flat array rather than a tree, and that is the point: the shape is fixed at two
 * levels by docs/decisions/0009-projects-sessions-terminals.md, and a recursive row
 * type would quietly permit the third level that ADR forbids.
 */
export type SidebarRow =
  | {
      readonly kind: "session";
      readonly session: Session;
      readonly status: SessionStatus;
      readonly indented: boolean;
    }
  | { readonly kind: "project"; readonly project: Project; readonly isExpanded: boolean };

/**
 * Derived only from what the daemon reported.
 *
 * A terminal with no reported state counts as nothing: the daemon has not spoken
 * about it, and rendering it as running would be a lie this client invented
 * (AGENTS.md § Non-negotiables 6).
 */
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

/**
 * Standalone sessions first, then one row per project with its sessions inside.
 *
 * Grouping happens here rather than through `SessionStore.inProject`, which builds
 * a fresh array per call and would therefore be a new reference on every render.
 * Mirror order throughout: the daemon decided the order and this does not second-
 * guess it.
 */
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

/** The state, as words. It travels beside the colour, never instead of it. */
export function statusText(status: SessionStatus): string {
  return STATUS_TEXT[status];
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  attention: "needs attention",
  running: "running",
  failed: "failed",
  idle: "idle",
};
