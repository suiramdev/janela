/**
 * The web entry point.
 *
 * Installs the log sink, builds the environment, and starts the connection *after*
 * first paint. Deliberately the only file here that touches the DOM directly.
 */

import { setLogSink, type LogRecord } from "@janela/support";
import {
  ClientEnvironmentProvider,
  MainWindow,
  createViewState,
  type ClientEnvironment,
} from "@janela/ui";
import { invoke } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { StrictMode, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { liveEnvironment } from "./environment.ts";
import { installNativeMenu, tauriCommandSource } from "./menu.ts";
import { tauriNativeShell } from "./native.ts";
import { localStorageSettings } from "./settings-storage.ts";

import "./styles.css";

/**
 * One record, as a line for Tauri's log plugin.
 *
 * `notice` has no counterpart in the plugin's five levels and maps to `info`;
 * everything else is one-to-one. Fire-and-forget, because a log line must never
 * be something the caller waits for — and records only ever carry shapes by
 * construction, so this cannot leak terminal traffic or an environment value.
 */
function writeRecord(record: LogRecord): void {
  const fields = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;
  const line = `${record.category}: ${record.message}${fields}`;
  switch (record.level) {
    case "debug":
      void debug(line);
      return;
    case "info":
    case "notice":
      void info(line);
      return;
    case "warning":
      void warn(line);
      return;
    case "error":
      void error(line);
      return;
  }
}

// Installed before anything can log, so a client log and a daemon log carry the
// same shapes and can be read side by side.
setLogSink({ write: writeRecord });
void trace("log sink installed");

/**
 * The graph, built once at module scope. Nothing here talks to the shell: the
 * first invoke happens in the effect below, after the window has painted.
 */
const environment = liveEnvironment();

/**
 * What this window is looking at, and the ports the views reach the desktop
 * through.
 *
 * `view` is constructed here rather than inside `liveEnvironment()` so the
 * composition root stays about the daemon connection — and so it stays
 * constructible by a headless test that has no React tree.
 */
const view = createViewState(environment.sessions);

/**
 * Pane focus, joined to attention delivery (#36).
 *
 * `focusTerminal` is `ViewState`'s single focus entry point (#37), so a
 * notification click lands the same way a menu chord or the jump list does.
 * Installed for the life of the process; the disposer exists for tests that build
 * a second graph, and there is only ever one window here.
 */
environment.focus.install((terminalID) => {
  view.focusTerminal(terminalID);
});

const clientEnvironment: ClientEnvironment = {
  projects: environment.projects,
  sessions: environment.sessions,
  connection: environment.connection,
  view,
  // The other direction: which pane has focus is the one fact the attention
  // policy cannot compute for itself, and only the view knows it.
  onFocusedTerminalChange: environment.focus.report,
  commands: tauriCommandSource(),
  native: tauriNativeShell(),
  settings: localStorageSettings(),
  service: {
    // Both are the *user's* explicit choice, made after the settings surface has
    // stated what stopping the daemon ends (non-negotiable #7).
    stop: () => void environment.stopBackgroundService(),
    stopAndUnregister: () =>
      void invoke<void>("unregister_launch_agent").then(
        () => environment.stopBackgroundService(),
        () => environment.stopBackgroundService(),
      ),
  },
  restartDaemon: () =>
    void environment.stopBackgroundService().then(() => environment.connection.connect()),
};

/** The window. */
function App(): ReactElement {
  useEffect(() => {
    // After first paint, and not awaited: a launch that blocks on a socket has
    // handed the daemon a veto over the launch budget. StrictMode fires this
    // twice in development, which is harmless — `connect()` is idempotent while a
    // loop is running, and registration reports the existing status rather than
    // registering twice.
    void environment.start();
    // The menu bar, built from `COMMANDS`. After the connection is asked for, and
    // not awaited either: a menu is not on the path to a painted window.
    void installNativeMenu(invoke);
  }, []);

  return (
    <ClientEnvironmentProvider environment={clientEnvironment}>
      <MainWindow />
    </ClientEnvironmentProvider>
  );
}

/** The element the app mounts into. Declared here so `index.html` and this agree. */
export const ROOT_ELEMENT_ID = "janela-root";

const container = document.getElementById(ROOT_ELEMENT_ID);
if (container === null) throw new Error(`index.html has no #${ROOT_ELEMENT_ID}`);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Launch budget instrument, until @janela/support's `begin("launch")` exists:
// navigation start → first animation frame, read next to the shell's own
// "window loaded" line. Fire-and-forget; nothing on the launch path awaits it.
requestAnimationFrame(() => {
  void info(`first frame ${Math.round(performance.now())} ms after navigation`);
});
