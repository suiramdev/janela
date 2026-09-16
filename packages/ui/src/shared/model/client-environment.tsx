import type { DaemonConnection, ProjectStore, SessionStore } from "@janela/client";
import type { AbsolutePath, TerminalID } from "@janela/core";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import type { CommandID } from "../config/index.ts";
import type { ConfirmationQueue } from "./confirmation.ts";
import type { SettingsStoring } from "./global-settings.ts";
import type { ViewState } from "./view-state.ts";

export interface CommandSource {
  subscribe(listener: (id: CommandID) => void): () => void;
}

export interface NativeShell {
  pickDirectory(options: { readonly title: string }): Promise<AbsolutePath | undefined>;

  revealInFinder(path: AbsolutePath): Promise<void>;
  openInTerminal(path: AbsolutePath): Promise<void>;
}

export interface WindowControls {
  readonly areVisible: boolean;
  subscribe(listener: () => void): () => void;
}

export interface Clipboard {
  copy(text: string): Promise<void>;
  paste(): Promise<string | undefined>;
}

export interface BackgroundServiceControlling {
  stop(): void;
  stopAndUnregister(): void;
}

export interface ClientEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;

  readonly view: ViewState;

  readonly commands: CommandSource;

  readonly native: NativeShell;

  readonly windowControls: WindowControls;

  readonly confirmations: ConfirmationQueue;

  readonly clipboard: Clipboard;

  readonly settings: SettingsStoring;

  readonly service: BackgroundServiceControlling;

  readonly restartDaemon: () => void;

  readonly onFocusedTerminalChange?: (id: TerminalID | undefined) => void;
}

const ClientEnvironmentContext = createContext<ClientEnvironment | undefined>(undefined);

export function ClientEnvironmentProvider(props: {
  readonly environment: ClientEnvironment;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <ClientEnvironmentContext.Provider value={props.environment}>
      {props.children}
    </ClientEnvironmentContext.Provider>
  );
}

export function useClientEnvironment(): ClientEnvironment {
  const environment = useContext(ClientEnvironmentContext);

  if (environment === undefined) {
    throw new Error(
      "useClientEnvironment: no ClientEnvironmentProvider above this view. Mount MainWindow inside one — the environment is the composition root's, not the view's.",
    );
  }

  return environment;
}

export function useStoreValue<Value>(
  store: { subscribe(listener: () => void): () => void },
  read: () => Value,
): Value {
  return useSyncExternalStore(store.subscribe, read, read);
}
