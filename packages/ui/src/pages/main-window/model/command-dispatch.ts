import type { DaemonConnection, ProjectStore, SessionStore } from "@janela/client";
import {
  focusedTab,
  focusNeighbour,
  isLive,
  type Axis,
  type Project,
  type Session,
  type SessionID,
  type TerminalID,
} from "@janela/core";
import type { SessionCreationIntent } from "@janela/protocol";

import type { CommandID } from "../../../shared/config/index.ts";
import {
  type ConfirmationRequest,
  type Confirming,
  type NativeShell,
  type ViewState,
  resolveLocalLayout,
  withFocusedTab,
} from "../../../shared/model/index.ts";

export interface CommandTarget {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: Pick<DaemonConnection, "request">;
  readonly view: ViewState;
  readonly native: NativeShell;
  readonly confirmations: Confirming;
}

export type CloseScope = "pane" | "tab" | "tabs";

const CLOSE_WORDS = {
  pane: { title: "Close this pane?", confirmLabel: "Close Pane" },
  tab: { title: "Close this tab?", confirmLabel: "Close Tab" },
  tabs: { title: "Close these tabs?", confirmLabel: "Close Tabs" },
} satisfies Record<CloseScope, { readonly title: string; readonly confirmLabel: string }>;

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

export function selectSession(store: SessionStore, id: SessionID): void {
  store.selection = id;
}

export function focusedTerminalOf(view: ViewState, session: Session): TerminalID | undefined {
  const ids = session.terminals.map((terminal) => terminal.id);
  const layout = resolveLocalLayout(view.layouts.get(session.id), session.layout, ids).local;

  return focusedTab(layout)?.focusedTerminalID;
}

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

export function createTerminal(
  connection: Pick<DaemonConnection, "request">,
  sessionID: SessionID,
): Promise<string | undefined> {
  return connection.request({ type: "createTerminal", sessionID });
}

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

export async function closeTerminals(
  target: Pick<CommandTarget, "sessions" | "connection" | "confirmations">,
  session: Session,
  terminals: readonly TerminalID[],
  scope: CloseScope,
): Promise<void> {
  const { sessions, connection, confirmations } = target;

  const live = terminals.filter((id) => {
    const state = sessions.terminalStates[id];

    return state !== undefined && isLive(state);
  });

  if (live.length > 0) {
    const agreed = await confirmations.confirm(closingCost(session, live, scope));

    if (!agreed) return;
  }

  await Promise.allSettled(
    terminals.map((terminalID) => connection.request({ type: "removeTerminal", terminalID })),
  );
}

function closingCost(
  session: Session,
  live: readonly TerminalID[],
  scope: CloseScope,
): ConfirmationRequest {
  const named = session.terminals.find((terminal) => terminal.id === live[0])?.title ?? "It";
  const words = CLOSE_WORDS[scope];

  return {
    title: words.title,
    message:
      live.length === 1
        ? `${named} is still running. Closing the ${scope} ends it.`
        : `${live.length} terminals are still running. Closing the ${scope} ends them.`,
    confirmLabel: words.confirmLabel,
    remember: "closeTerminals",
  };
}

export function createCommandDispatch(target: CommandTarget): (id: CommandID) => Promise<void> {
  const { projects, sessions, connection, view, native } = target;

  const currentSession = (): Session | undefined =>
    sessions.sessions.find((session) => session.id === sessions.selection);

  const focusedIn = (session: Session): TerminalID | undefined => focusedTerminalOf(view, session);

  const openFolder = async (): Promise<void> => {
    const directory = await native.pickDirectory({ title: "Open Folder" });

    if (directory === undefined) return;

    await createSessionAndSelect(target, { kind: "standalone", directory });
  };

  const split = async (axis: Axis): Promise<void> => {
    const session = currentSession();

    if (session === undefined) return;

    const beside = focusedIn(session);

    if (beside === undefined) return;

    await splitTerminal(connection, session.id, beside, axis);
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

    await closeTerminals(target, session, [terminalID], "pane");
  };

  const restart = async (): Promise<void> => {
    const session = currentSession();

    if (session === undefined) return;

    const terminalID = focusedIn(session);

    if (terminalID === undefined) return;

    await connection.request({ type: "restartTerminal", terminalID });
  };

  const focusNeighbourPane = (direction: "left" | "right" | "up" | "down"): void => {
    const session = currentSession();

    if (session === undefined) return;

    view.applyLayout(session.id, (layout) => focusNeighbour(layout, direction));
  };

  const actions = {
    openSettings: () => {
      view.showSettings();
    },

    newSession: () => {
      const projectID = currentSession()?.projectID;

      view.openSheet(
        projectID === undefined ? { kind: "newSession" } : { kind: "newSession", projectID },
      );
    },

    newTerminal: async () => {
      const session = currentSession();

      if (session === undefined) return;

      await createTerminal(connection, session.id);
    },

    openFolder,

    addProject: async () => {
      const directory = await native.pickDirectory({ title: "Add Project" });

      if (directory === undefined) return;

      await connection.request({ type: "addProject", directory });
    },

    showCommands: () => {
      view.openSheet({ kind: "commands" });
    },

    goToSession: () => {
      view.openSheet({ kind: "jumpList" });
    },

    nextSession: () => {
      stepSession(1);
    },

    previousSession: () => {
      stepSession(-1);
    },

    revealInFinder: async () => {
      const session = currentSession();

      if (session === undefined) return;

      await native.revealInFinder(session.directory);
    },

    openInTerminal: async () => {
      const session = currentSession();

      if (session === undefined) return;

      await native.openInTerminal(session.directory);
    },

    splitRight: () => split("horizontal"),
    splitDown: () => split("vertical"),

    focusPaneLeft: () => {
      focusNeighbourPane("left");
    },

    focusPaneRight: () => {
      focusNeighbourPane("right");
    },

    focusPaneUp: () => {
      focusNeighbourPane("up");
    },

    focusPaneDown: () => {
      focusNeighbourPane("down");
    },

    nextTab: () => {
      stepTab(1);
    },

    previousTab: () => {
      stepTab(-1);
    },

    closePane,
    restartTerminal: restart,

    clearScrollback: () => {
      const session = currentSession();

      if (session === undefined) return;

      const terminalID = focusedIn(session);

      if (terminalID === undefined) return;

      view.surface(terminalID)?.clearViewport();
    },
  } satisfies Record<CommandID, () => void | Promise<void>>;

  return async (id: CommandID): Promise<void> => {
    await actions[id]();
  };
}
