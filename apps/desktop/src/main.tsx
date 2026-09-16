import { setLogSink, type LogRecord } from "@janela/support";
import {
  ClientEnvironmentProvider,
  MainWindow,
  SettingsScreen,
  browserClipboard,
  createConfirmationQueue,
  createViewState,
  localStorageSettings,
  type ClientEnvironment,
  type SettingsRoute,
} from "@janela/ui";
import { invoke } from "@tauri-apps/api/core";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { Match } from "effect";
import { StrictMode, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { installNativeMenu, tauriCommandSource } from "./adapters/menu.ts";
import { tauriNativeShell } from "./adapters/native.ts";
import { tauriWindowControls } from "./adapters/window-controls.ts";
import { liveEnvironment } from "./environment.ts";

import "@janela/design/styles.css";

const environment = liveEnvironment();

const view = createViewState(environment.sessions);

const settingsStore = localStorageSettings();

const confirmations = createConfirmationQueue({ view, settings: settingsStore });

const clientEnvironment: ClientEnvironment = {
  projects: environment.projects,
  sessions: environment.sessions,
  connection: environment.connection,
  view,
  onFocusedTerminalChange: environment.focus.report,
  commands: tauriCommandSource(),
  windowControls: tauriWindowControls(),
  confirmations,
  clipboard: browserClipboard(),
  settings: settingsStore,
  local: {
    native: tauriNativeShell(),
    service: {
      stop: () => void environment.stopBackgroundService(),
      stopAndUnregister: () =>
        void invoke<void>("unregister_launch_agent").then(
          () => environment.stopBackgroundService(),
          () => environment.stopBackgroundService(),
        ),
    },
    restartDaemon: () =>
      void environment.stopBackgroundService().then(() => environment.connection.connect()),
  },
};

const renderSettings = (route: SettingsRoute): ReactElement => <SettingsScreen route={route} />;

export const ROOT_ELEMENT_ID = "janela-root";

const container = document.getElementById(ROOT_ELEMENT_ID);

function writeRecord(record: LogRecord): void {
  const fields = record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`;
  const line = `${record.category}: ${record.message}${fields}`;

  Match.value(record.level).pipe(
    Match.when("debug", () => void debug(line)),
    Match.whenOr("info", "notice", () => void info(line)),
    Match.when("warning", () => void warn(line)),
    Match.when("error", () => void error(line)),
    Match.exhaustive,
  );
}

function App(): ReactElement {
  useEffect(() => {
    void environment.start();
    void installNativeMenu(invoke);
  }, []);

  return (
    <ClientEnvironmentProvider environment={clientEnvironment}>
      <MainWindow renderSettings={renderSettings} />
    </ClientEnvironmentProvider>
  );
}

setLogSink({ write: writeRecord });

void trace("log sink installed");

environment.focus.install((terminalID) => {
  view.focusTerminal(terminalID);
});

if (container === null) throw new Error(`index.html has no #${ROOT_ELEMENT_ID}`);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

requestAnimationFrame(() => {
  void info(`first frame ${Math.round(performance.now())} ms after navigation`);
});
