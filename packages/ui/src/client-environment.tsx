/**
 * What a view needs from the process it is running in, and how it gets it.
 *
 * `MainWindow()` takes no props — it is the window, not a widget — and the
 * composition root that owns the connection lives one layer up in `apps/desktop`.
 * So the environment arrives by context, and **the interface lives down here**,
 * with the code that consumes it: the layering rule says an upward reference is a
 * missing interface in the lower package (AGENTS.md § The layering rule).
 *
 * Note what is absent: attention delivery. Whether a signal interrupts anybody is
 * `AttentionPolicy`'s call and #36's work; this layer only reports which terminal
 * has focus, which is the one fact the policy cannot compute for itself.
 */

import type { DaemonConnection, ProjectStore, SessionStore } from "@janela/client";
import type { TerminalID } from "@janela/core";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

export interface ClientEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;

  /**
   * Stops `janelad` so the next connection starts the new build.
   *
   * The version-skew banner's button, and the only thing that may cause it:
   * restarting the daemon kills live terminals, so it is always an explicit user
   * choice (AGENTS.md § Non-negotiables 7). Implemented by the app (#30).
   */
  readonly restartDaemon: () => void;

  /**
   * Called with the focused terminal, or `undefined` when no pane has focus.
   *
   * Feeds `AttentionContext.focusedTerminalID`. The selected session is not
   * reported: it is already in `SessionStore.selection`, and a second channel for
   * the same fact is a second thing that can be wrong.
   */
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

/**
 * Subscribes to one value in one store.
 *
 * The third argument is the point: without a server snapshot,
 * `renderToStaticMarkup` throws, and these views are tested by rendering them to
 * markup. `read` must return something reference-stable between notifications —
 * every store getter here does, and composing an object literal in it would
 * re-render forever.
 */
export function useStoreValue<Value>(
  store: { subscribe(listener: () => void): () => void },
  read: () => Value,
): Value {
  return useSyncExternalStore(store.subscribe, read, read);
}
