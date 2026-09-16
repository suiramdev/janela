import { setLogSink } from "@janela/support";
import {
  ClientEnvironmentProvider,
  MainWindow,
  NO_WINDOW_CONTROLS,
  SettingsScreen,
  availableCommands,
  browserClipboard,
  createConfirmationQueue,
  createViewState,
  keyboardCommandSource,
  localStorageSettings,
  type ClientEnvironment,
  type SettingsRoute,
} from "@janela/ui";
import { StrictMode, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { webEnvironment } from "./environment.ts";
import { consoleLogSink } from "./log-sink.ts";

import "@janela/design/styles.css";

setLogSink(consoleLogSink());

const environment = webEnvironment();

const view = createViewState(environment.sessions);

const settingsStore = localStorageSettings();

const confirmations = createConfirmationQueue({ view, settings: settingsStore });

const clientEnvironment: ClientEnvironment = {
  projects: environment.projects,
  sessions: environment.sessions,
  connection: environment.connection,
  view,
  commands: keyboardCommandSource(window, availableCommands(false)),
  windowControls: NO_WINDOW_CONTROLS,
  confirmations,
  clipboard: browserClipboard(),
  settings: settingsStore,
  local: undefined,
};

const renderSettings = (route: SettingsRoute): ReactElement => <SettingsScreen route={route} />;

export const ROOT_ELEMENT_ID = "janela-root";

const container = document.getElementById(ROOT_ELEMENT_ID);

function App(): ReactElement {
  useEffect(() => {
    void environment.start();
  }, []);

  return (
    <ClientEnvironmentProvider environment={clientEnvironment}>
      <MainWindow renderSettings={renderSettings} />
    </ClientEnvironmentProvider>
  );
}

if (container === null) throw new Error(`index.html has no #${ROOT_ELEMENT_ID}`);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
