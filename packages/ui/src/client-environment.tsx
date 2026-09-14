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
import type { AbsolutePath, TerminalID } from "@janela/core";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import type { BackgroundServiceControlling } from "./background-service.ts";
import type { CommandID } from "./commands.ts";
import type { ConfirmationQueue } from "./confirmation.ts";
import type { SettingsStoring } from "./global-settings.ts";
import type { ViewState } from "./view-state.ts";

/**
 * Where a chosen command arrives from.
 *
 * A port because the menu bar is native and lives in the shell: the views know
 * that a command happened, not that a `tauri://` event carried it. A second
 * client — a CLI, a browser — supplies its own source and every row still works.
 */
export interface CommandSource {
  subscribe(listener: (id: CommandID) => void): () => void;
}

/**
 * The parts of the desktop the client may ask for by name.
 *
 * Everything here is something only the shell can do, and it is down to three:
 * a directory only the OS can let someone pick, and the two places outside this
 * window a path can be opened in. Asking a question is no longer one of them —
 * a confirmation is this application's own dialog now (`confirmation.tsx`),
 * because a native alert has no room for "Don't ask again" and nothing in a
 * test can read one.
 */
export interface NativeShell {
  /** Native directory dialog; `undefined` when the user cancelled. */
  pickDirectory(options: { readonly title: string }): Promise<AbsolutePath | undefined>;

  revealInFinder(path: AbsolutePath): Promise<void>;
  openInTerminal(path: AbsolutePath): Promise<void>;
}

/**
 * The system clipboard, as two requests.
 *
 * A seam rather than a direct `navigator.clipboard` call, for the usual reason:
 * the app is the composition root and a test gets a fake. It is also the one
 * place where a platform can refuse — reading the clipboard is a permission on
 * some, and a refusal is *not* an error to show anyone. A paste that cannot
 * read answers `undefined` and the terminal receives nothing, which is what
 * pressing the key with an empty clipboard does too (AGENTS.md §
 * Non-negotiables 10).
 */
export interface Clipboard {
  copy(text: string): Promise<void>;
  /** The clipboard's text, or `undefined` when it is empty or unreadable. */
  paste(): Promise<string | undefined>;
}

export interface ClientEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;

  /** What this window is looking at: pane focus, the open sheet, settings. */
  readonly view: ViewState;

  /** Chosen menu commands, as ids. See `COMMANDS`. */
  readonly commands: CommandSource;

  /** The directory picker, Finder and Terminal.app. */
  readonly native: NativeShell;

  /**
   * Questions with a cost, as a promise. The one dialog that is not a sheet.
   *
   * On the environment rather than reached for by the view that renders it,
   * because the callers are decisions — `closeTerminals`, the sidebar's
   * removals, the version-skew banner — and none of them is inside a component.
   */
  readonly confirmations: ConfirmationQueue;

  /** Copy and paste, for the terminal's context menu. */
  readonly clipboard: Clipboard;

  /** Where `GlobalSettings` are kept. The app supplies the storage. */
  readonly settings: SettingsStoring;

  /** Stopping `janelad`, with the cost shown first. */
  readonly service: BackgroundServiceControlling;

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
