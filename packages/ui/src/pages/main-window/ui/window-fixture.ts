import type {
  ConnectionStatus,
  DaemonConnection,
  ProjectStore,
  SessionStore,
} from "@janela/client";
import type { Project, Session, SessionID, TerminalID, TerminalState } from "@janela/core";

import {
  inertClipboard,
  inertNativeShell,
  memorySettingsStore,
  neverCommands,
  overlaidWindowControls,
  recordingAppearance,
  recordingConfirmations,
  recordingDirectoryPicker,
  recordingNotificationSound,
  recordingService,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  createViewState,
  type ClientEnvironment,
  type WindowControls,
} from "../../../shared/model/index.ts";
import { NO_STATES } from "../model/session-fixture.ts";

export const ignoreCommand = (): undefined => undefined;

const noop = (): (() => void) => () => {};

export function fakeEnvironment(options: {
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly states?: Readonly<Record<TerminalID, TerminalState>>;
  readonly selection?: SessionID;
  readonly status?: ConnectionStatus;
  readonly windowControls?: WindowControls;
}): ClientEnvironment {
  const sessions = options.sessions ?? [];
  const states = options.states ?? NO_STATES;

  const projects: ProjectStore = {
    projects: options.projects ?? [],
    find: (id) => (options.projects ?? []).find((candidate) => candidate.id === id),
    subscribe: noop,
  };

  const sessionStore: SessionStore = {
    sessions,
    selection: options.selection,
    terminalStates: states,
    inProject: (id) => sessions.filter((candidate) => candidate.projectID === id),
    standaloneSessions: sessions.filter((candidate) => candidate.projectID === undefined),
    isRunning: (id) => {
      const found = sessions.find((candidate) => candidate.id === id);

      return (found?.terminals ?? []).some((entry) => states[entry.id]?.kind === "running");
    },
    subscribe: noop,
  };

  const connection: DaemonConnection = {
    status: options.status ?? { kind: "idle" },
    isStale: false,
    connect: async () => {},
    request: async () => undefined,
    sendInput: () => {},
    onOutput: noop,
    onAttention: noop,
    subscribe: noop,
    disconnect: async () => {},
  };

  return {
    projects,
    sessions: sessionStore,
    connection,
    view: createViewState(sessionStore),
    commands: neverCommands(),
    windowControls: options.windowControls ?? overlaidWindowControls,
    confirmations: recordingConfirmations({ agrees: false, silenced: undefined }),
    directories: recordingDirectoryPicker(),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    local: {
      native: inertNativeShell(),
      service: recordingService(),
      appearance: recordingAppearance(),
      restartDaemon: () => {},
      sound: recordingNotificationSound(),
    },
  };
}
