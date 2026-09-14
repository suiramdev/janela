import type { DaemonConnection, ProjectStore, SessionStore } from "@janela/client";
import {
  focusedTab,
  focusNeighbour,
  type Axis,
  type Project,
  type Session,
  type SessionID,
  type TerminalID,
} from "@janela/core";
import type { SessionCreationIntent } from "@janela/protocol";

import type { NativeShell } from "./client-environment.tsx";
import type { CommandID } from "./commands.ts";
import { resolveLocalLayout, withFocusedTab } from "./layout-edits.ts";
import type { ViewState } from "./view-state.ts";

/**
 * What every row of `COMMANDS` actually does.
 *
 * One exhaustive `switch` with no `default`, so a command added to the table
 * without an action here fails `typecheck` rather than being a menu item that does
 * nothing. That is the whole point of the file: the table is data, and this is the
 * one place that reads it as instructions.
 *
 * ## Nothing here is enabled or disabled
 *
 * A menu item is always clickable, and a command with no applicable target does
 * nothing at all — quietly. Enabled state would mean the shell asking the client
 * about every row on every menu open, and a greyed-out "Split Vertically" teaches a
 * user nothing they did not already know from having no session selected.
 *
 * ## Requests are best-effort
 *
 * A request while the daemon is away rejects, and that is routine: nothing is
 * queued by design, and the mirror keeps rendering what it last knew. Callers
 * ignore the rejection.
 */
export interface CommandTarget {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: Pick<DaemonConnection, "request">;
  readonly view: ViewState;
  readonly native: NativeShell;
}

/**
 * The order ⌘⇧] and ⌘⇧[ walk: standalone sessions first, then each project's, in
 * the order the sidebar draws them.
 *
 * The sidebar's order rather than the mirror's, because "next" means the next one
 * down the list the user is looking at.
 */
export function sessionOrder(
  projects: readonly Project[],
  sessions: readonly Session[],
): readonly Session[] {
  const standalone = sessions.filter((session) => session.projectID === undefined);
  const grouped = projects.flatMap((project) =>
    sessions.filter((session) => session.projectID === project.id),
  );
  return [...standalone, ...grouped];
}

/**
 * The one field of the mirror a client owns.
 *
 * `SessionStore.selection` is documented as purely local — never sent, never
 * received — and its setter notifies, so this assignment is the whole of "select a
 * session". It lives in a function rather than inline in the views because it is
 * the only place any view writes to a store, and that deserves to be one line
 * someone can find.
 */
export function selectSession(store: SessionStore, id: SessionID): void {
  store.selection = id;
}

/**
 * The focused pane of a session, resolved through this window's local layout.
 *
 * The layout the *user* is looking at, not the mirror's: a tab switch is local, so
 * asking the mirror which pane has focus would answer for a different window.
 */
export function focusedTerminalOf(view: ViewState, session: Session): TerminalID | undefined {
  const ids = session.terminals.map((terminal) => terminal.id);
  const layout = resolveLocalLayout(view.layouts.get(session.id), session.layout, ids).local;
  return focusedTab(layout)?.focusedTerminalID;
}

/**
 * Creates a session and lands the keyboard in it.
 *
 * The daemon publishes the state snapshot *before* the reply to the request that
 * caused it, on the same ordered queue, so the mirror already has the new session
 * by the time the request settles. Focus goes to its pane, not just its sidebar
 * row: creating a session means wanting to type in it.
 */
export async function createSessionAndSelect(
  target: Pick<CommandTarget, "sessions" | "connection" | "view">,
  intent: SessionCreationIntent,
): Promise<void> {
  const { sessions, connection, view } = target;
  const before = new Set(sessions.sessions.map((session) => session.id));

  await connection.request({ type: "createSession", intent });

  const appeared = sessions.sessions
    .filter((session) => !before.has(session.id))
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (appeared === undefined) return;

  const terminal = focusedTerminalOf(view, appeared);
  if (terminal === undefined) selectSession(sessions, appeared.id);
  else view.focusTerminal(terminal);
}

/**
 * A new terminal in a session: a login shell, in a new focused tab.
 *
 * No profile, ever. A new pane is a terminal — the ⌘T picker that once asked
 * "which kind?" is gone, and a launch profile is something a terminal may be
 * started with later, not a kind of pane. The daemon configures it; the pane
 * starts it on attach.
 */
export function createTerminal(
  connection: Pick<DaemonConnection, "request">,
  sessionID: SessionID,
): Promise<string | undefined> {
  return connection.request({ type: "createTerminal", sessionID });
}

/**
 * Splits the pane holding `beside` and puts a new shell in the other half.
 *
 * The split is the daemon's — part of the session's layout, persisted with it —
 * which is why this is a request and not a local layout edit. Like `createTerminal`,
 * no profile is inherited: the new half is a terminal, whatever the old one runs.
 */
export function splitTerminal(
  connection: Pick<DaemonConnection, "request">,
  sessionID: SessionID,
  beside: TerminalID,
  axis: Axis,
): Promise<string | undefined> {
  return connection.request({
    type: "createTerminal",
    sessionID,
    placement: { kind: "split", beside, axis },
  });
}

export function createCommandDispatch(target: CommandTarget): (id: CommandID) => Promise<void> {
  const { projects, sessions, connection, view, native } = target;

  /** The session the sidebar has selected, if the mirror still has it. */
  const currentSession = (): Session | undefined =>
    sessions.sessions.find((session) => session.id === sessions.selection);

  /** This window's focused pane in `session`. */
  const focusedIn = (session: Session): TerminalID | undefined => focusedTerminalOf(view, session);

  /** Picks a directory and creates a standalone session in it. */
  const openFolder = async (): Promise<void> => {
    const directory = await native.pickDirectory({ title: "Open Folder" });
    if (directory === undefined) return;
    await createSessionAndSelect(target, { kind: "standalone", directory });
  };

  const split = (axis: Axis): Promise<unknown> | undefined => {
    const session = currentSession();
    if (session === undefined) return undefined;
    const beside = focusedIn(session);
    if (beside === undefined) return undefined;
    return splitTerminal(connection, session.id, beside, axis);
  };

  const stepSession = (delta: -1 | 1): void => {
    const order = sessionOrder(projects.projects, sessions.sessions);
    if (order.length === 0) return;
    const at = order.findIndex((session) => session.id === sessions.selection);
    const next = at === -1 ? order[0] : order[(at + delta + order.length) % order.length];
    if (next !== undefined) sessions.selection = next.id;
  };

  const stepTab = (delta: -1 | 1): void => {
    const session = currentSession();
    if (session === undefined) return;
    view.applyLayout(session.id, (layout) => {
      const count = layout.tabs.length;
      if (count === 0) return layout;
      return withFocusedTab(layout, (layout.focusedTabIndex + delta + count) % count);
    });
  };

  const closePane = async (): Promise<void> => {
    const session = currentSession();
    if (session === undefined) return;
    const terminalID = focusedIn(session);
    if (terminalID === undefined) return;

    const state = sessions.terminalStates[terminalID];
    if (state?.kind === "running" || state?.kind === "needsAttention") {
      const title = session.terminals.find((terminal) => terminal.id === terminalID)?.title ?? "It";
      const agreed = await native.confirm({
        title: "Close this pane?",
        message: `${title} is still running. Closing the pane ends it.`,
        confirmLabel: "Close Pane",
      });
      if (!agreed) return;
    }

    await connection.request({ type: "removeTerminal", terminalID });
  };

  const restart = async (): Promise<void> => {
    const session = currentSession();
    if (session === undefined) return;
    const terminalID = focusedIn(session);
    if (terminalID === undefined) return;

    // One request, not a stop followed by a start: closing a pty leaves the
    // terminal `running` until the daemon's reader thread reaps the child, so a
    // start sent straight afterwards finds a terminal that looks alive and does
    // nothing. The ordering belongs where the reaping is visible.
    await connection.request({ type: "restartTerminal", terminalID });
  };

  const focusNeighbourPane = (direction: "left" | "right" | "up" | "down"): void => {
    const session = currentSession();
    if (session === undefined) return;
    view.applyLayout(session.id, (layout) => focusNeighbour(layout, direction));
  };

  return async (id: CommandID): Promise<void> => {
    switch (id) {
      case "openSettings":
        view.showSettings();
        return;

      case "newSession": {
        const session = currentSession();
        const projectID = session?.projectID;
        // In a project, the same dialog the project's `+` opens; otherwise the
        // question is "which folder?", which is Open Folder's question.
        if (projectID === undefined) return openFolder();
        view.openSheet({ kind: "newSession", projectID });
        return;
      }

      case "newTerminal": {
        const session = currentSession();
        if (session === undefined) return;
        await createTerminal(connection, session.id);
        return;
      }

      case "openFolder":
        return openFolder();

      case "addProject": {
        const directory = await native.pickDirectory({ title: "Add Project" });
        if (directory === undefined) return;
        await connection.request({ type: "addProject", directory });
        return;
      }

      case "showCommands":
        view.openSheet({ kind: "commands" });
        return;

      case "goToSession":
        view.openSheet({ kind: "jumpList" });
        return;

      case "newBranchSession":
        view.openSheet({ kind: "newBranch" });
        return;

      case "nextSession":
        stepSession(1);
        return;

      case "previousSession":
        stepSession(-1);
        return;

      case "revealInFinder": {
        const session = currentSession();
        if (session === undefined) return;
        await native.revealInFinder(session.directory);
        return;
      }

      case "openInTerminal": {
        const session = currentSession();
        if (session === undefined) return;
        await native.openInTerminal(session.directory);
        return;
      }

      case "splitRight":
        await split("horizontal");
        return;

      case "splitDown":
        await split("vertical");
        return;

      case "focusPaneLeft":
        focusNeighbourPane("left");
        return;

      case "focusPaneRight":
        focusNeighbourPane("right");
        return;

      case "focusPaneUp":
        focusNeighbourPane("up");
        return;

      case "focusPaneDown":
        focusNeighbourPane("down");
        return;

      case "nextTab":
        stepTab(1);
        return;

      case "previousTab":
        stepTab(-1);
        return;

      case "closePane":
        return closePane();

      case "restartTerminal":
        return restart();

      case "clearScrollback": {
        const session = currentSession();
        if (session === undefined) return;
        const terminalID = focusedIn(session);
        if (terminalID === undefined) return;
        // This client's view only. The daemon's scrollback is untouched, which is
        // what makes it safe to do by reflex.
        view.surface(terminalID)?.clearViewport();
        return;
      }
    }
  };
}
