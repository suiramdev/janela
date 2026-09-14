import type { DaemonConnection, SessionStore } from "@janela/client";
import type { AbsolutePath, Project, ProjectID, Session, SessionID } from "@janela/core";
import { parseRemovalPlan, type SessionRemovalPreview } from "@janela/protocol";

import type { NativeShell } from "./client-environment.tsx";
import { createTerminal } from "./command-dispatch.ts";
import type { ViewState } from "./view-state.ts";

/**
 * What a project's or a session's contextual actions actually do.
 *
 * Lifted out of the view for the same reason `createCommandDispatch` is: these
 * are the interesting decisions — which confirmation is shown, what the daemon is
 * asked for, in which order — and a decision buried in a `ContextMenuItem` can
 * only be tested by rendering one.
 *
 * Everything here is best-effort, like every other request a view makes: an
 * action taken while the daemon is away fails and the window keeps rendering the
 * mirror (AGENTS.md § Non-negotiables 8).
 *
 * ## Why this is not a `CommandID`
 *
 * `COMMANDS` is the menu bar, and every row of it acts on *the selection*.
 * A context menu acts on the row it was opened over, which is frequently not the
 * selection — right-clicking a project you have not visited to make a session in
 * it is the whole point of the gesture. So these take their subject as an
 * argument, and the two never have to agree about what "current" means.
 */

export interface SidebarActionTarget {
  readonly sessions: SessionStore;
  readonly connection: Pick<DaemonConnection, "request">;
  readonly view: ViewState;
  readonly native: NativeShell;
}

export interface SidebarActions {
  /** Opens the new-session dialog: which branch, and where it is worked on. */
  newSession(projectID: ProjectID): void;
  /** A new branch, made by name: opens the branch sheet with this project preselected. */
  newBranchSession(projectID: ProjectID): void;
  /** A new terminal in the session. Always a shell — there is nothing to pick. */
  newTerminal(sessionID: SessionID): void;
  openProjectSettings(projectID: ProjectID): void;
  /** Confirms first, naming the sessions that go with it. */
  removeProject(project: Project): void;
  /** Asks the daemon what removal would cost, names it, then removes. */
  removeSession(session: Session): void;
  revealInFinder(path: AbsolutePath): void;
  openInTerminal(path: AbsolutePath): void;
}

/** A request from a view is best-effort. Failing one is not an application error. */
function swallowRequestFailure(): undefined {
  return undefined;
}

export function createSidebarActions(target: SidebarActionTarget): SidebarActions {
  const { sessions, connection, view, native } = target;

  const removeSession = async (session: Session): Promise<void> => {
    // The plan first, and from the daemon: whether a directory would be deleted,
    // and whether that loses work, depends on git state only the daemon can read.
    // A client that guessed would eventually guess "safe" about uncommitted work.
    const reply = await connection.request({ type: "removalPlan", sessionID: session.id });
    if (reply === undefined) return;
    const plan = parseRemovalPlan(reply);

    const agreed = await native.confirm(sessionRemovalPrompt(session, plan));
    if (!agreed) return;

    await connection.request({
      type: "removeSession",
      sessionID: session.id,
      // The plan says what the daemon would do; the client sends its own answer
      // back. This client agrees with it, having just shown the user what it
      // means — there is no second dialog offering to keep the directory,
      // because there is no third button on a native confirmation.
      deletesDirectory: plan.deletesDirectory,
    });
  };

  const removeProject = async (project: Project): Promise<void> => {
    const contained = sessions.inProject(project.id);
    const agreed = await native.confirm(projectRemovalPrompt(project, contained.length));
    if (!agreed) return;
    await connection.request({ type: "removeProject", projectID: project.id });
  };

  return {
    newSession(projectID: ProjectID): void {
      view.openSheet({ kind: "newSession", projectID });
    },

    newBranchSession(projectID: ProjectID): void {
      view.openSheet({ kind: "newBranch", projectID });
    },

    newTerminal(sessionID: SessionID): void {
      void createTerminal(connection, sessionID).catch(swallowRequestFailure);
    },

    openProjectSettings(projectID: ProjectID): void {
      view.openSheet({ kind: "projectSettings", projectID });
    },

    removeProject(project: Project): void {
      void removeProject(project).catch(swallowRequestFailure);
    },

    removeSession(session: Session): void {
      void removeSession(session).catch(swallowRequestFailure);
    },

    revealInFinder(path: AbsolutePath): void {
      void native.revealInFinder(path).catch(swallowRequestFailure);
    },

    openInTerminal(path: AbsolutePath): void {
      void native.openInTerminal(path).catch(swallowRequestFailure);
    },
  };
}

export interface ConfirmationPrompt {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
}

/**
 * What removing this session costs, in words, before it is removed.
 *
 * Every clause is conditional on the plan, because a confirmation that lists
 * consequences that will not happen is a confirmation people learn to dismiss.
 * The `safety` flags are named individually for the same reason the wire type
 * carries them individually rather than as a boolean: "has uncommitted changes"
 * is actionable and "unsafe" is not.
 */
export function sessionRemovalPrompt(
  session: Session,
  plan: SessionRemovalPreview,
): ConfirmationPrompt {
  const parts: string[] = [];

  if (plan.liveTerminalCount > 0) {
    parts.push(
      plan.liveTerminalCount === 1
        ? "1 running terminal ends."
        : `${plan.liveTerminalCount} running terminals end.`,
    );
  }
  if (plan.runsTeardownAutomation) parts.push("The session teardown command runs first.");
  if (plan.deletesDirectory) {
    parts.push(`${session.directory} is deleted.`);
    if (plan.includedPaths.length > 0) {
      parts.push(`${plan.includedPaths.length} copied-in file(s) go with it.`);
    }
    const losses = safetyLosses(plan);
    if (losses.length > 0) parts.push(`It still has ${listed(losses)}.`);
  } else if (plan.canDeleteDirectory) {
    parts.push(`${session.directory} is kept.`);
  }

  return {
    title: `Remove ${session.name}?`,
    // Never empty: a confirmation with no body is a dialog that has not said why
    // it is asking.
    message: parts.length === 0 ? "The session is removed from the sidebar." : parts.join(" "),
    confirmLabel: "Remove Session",
  };
}

/** Removing a project removes its sessions, which is the part worth saying out loud. */
export function projectRemovalPrompt(project: Project, sessionCount: number): ConfirmationPrompt {
  return {
    title: `Remove ${project.name}?`,
    message:
      sessionCount === 0
        ? `Janela stops offering ${project.directory}. Nothing on disk changes.`
        : `Its ${sessionCount === 1 ? "session" : `${sessionCount} sessions`} ${
            sessionCount === 1 ? "goes" : "go"
          } with it, and their terminals end. The project's own directory is untouched.`,
    confirmLabel: "Remove Project",
  };
}

/** The reasons this directory still holds work, as phrases. */
function safetyLosses(plan: SessionRemovalPreview): readonly string[] {
  const { safety } = plan;
  const losses: string[] = [];
  if (safety.hasUncommittedChanges) losses.push("uncommitted changes");
  if (safety.hasUntrackedFiles) losses.push("untracked files");
  if (safety.hasUnpushedCommits) losses.push("unpushed commits");
  if (safety.isLocked) losses.push("a locked worktree");
  return losses;
}

/** `a, b and c` — an English list, because this text is read aloud by a screen reader. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}
