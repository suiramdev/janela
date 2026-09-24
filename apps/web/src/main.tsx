import { setLogSink } from "@janela/support";
import {
  ClientEnvironmentProvider,
  DirectoryPickerHost,
  MainWindow,
  NO_WINDOW_CONTROLS,
  SettingsScreen,
  browserClipboard,
  browserLinks,
  createConfirmationQueue,
  createDirectoryPickerQueue,
  commandsWithShortcuts,
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

const directories = createDirectoryPickerQueue();

const clientEnvironment: ClientEnvironment = {
  projects: environment.projects,
  sessions: environment.sessions,
  connection: environment.connection,
  view,
  commands: keyboardCommandSource(
    window,
    () => commandsWithShortcuts(view.settings, false),
    () => directories.pending !== undefined,
    () => view.isRecordingShortcut,
  ),
  windowControls: NO_WINDOW_CONTROLS,
  confirmations,
  directories,
  clipboard: browserClipboard(),
  links: browserLinks(),
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
      <DirectoryPickerHost picker={directories} />
    </ClientEnvironmentProvider>
  );
}

if (container === null) throw new Error(`index.html has no #${ROOT_ELEMENT_ID}`);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
