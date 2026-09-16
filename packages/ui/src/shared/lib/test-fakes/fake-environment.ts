import { createStores } from "@janela/client";
import type { Project, Session, TerminalID, TerminalState } from "@janela/core";
import type { StateUpdate } from "@janela/protocol";

import { type ClientEnvironment, createViewState } from "../../model/index.ts";
import {
  inertClipboard,
  inertNativeShell,
  memorySettingsStore,
  neverCommands,
  overlaidWindowControls,
  recordingConfirmations,
  recordingService,
} from "./recording-ports.ts";

export function fakeClientEnvironment(): ClientEnvironment {
  const stores = createStores();

  return {
    projects: stores.projects,
    sessions: stores.sessions,
    connection: {
      status: { kind: "idle" },
      isStale: false,
      connect: () => Promise.resolve(),
      request: () => Promise.resolve(undefined),
      sendInput: () => {},
      onOutput: () => () => {},
      onAttention: () => () => {},
      subscribe: () => () => {},
      disconnect: () => Promise.resolve(),
    },
    view: createViewState(stores.sessions),
    commands: neverCommands(),
    native: inertNativeShell(),
    windowControls: overlaidWindowControls,
    confirmations: recordingConfirmations({ agrees: false, silenced: undefined }),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    service: recordingService(),
    restartDaemon: () => {},
  };
}

export function environmentOver(state: {
  readonly sessions: readonly Session[];
  readonly projects?: readonly Project[];
  readonly terminalStates?: Readonly<Record<TerminalID, TerminalState>>;
}): ClientEnvironment {
  const stores = createStores();

  const update: StateUpdate = {
    sessions: state.sessions,
    projects: state.projects ?? [],
    terminalStates: state.terminalStates ?? {},
    launchProfiles: [],
    launchProfileAvailability: {},
    isFullSnapshot: true,
  };

  stores.mirror.apply(update);

  return {
    projects: stores.projects,
    sessions: stores.sessions,
    connection: fakeClientEnvironment().connection,
    view: createViewState(stores.sessions),
    commands: neverCommands(),
    native: inertNativeShell(),
    windowControls: overlaidWindowControls,
    confirmations: recordingConfirmations({ agrees: false, silenced: undefined }),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    service: recordingService(),
    restartDaemon: () => {},
  };
}
