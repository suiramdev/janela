/**
 * The web entry point.
 *
 * Installs the log sink, builds the environment, and starts the connection *after*
 * first paint. Deliberately the only file here that touches the DOM directly.
 */

import { setLogSink, type LogRecord } from "@janela/support";
import { debug, error, info, trace, warn } from "@tauri-apps/plugin-log";
import { StrictMode, useEffect, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { liveEnvironment } from "./environment.ts";

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
 * The window.
 *
 * `MainWindow` from `@janela/ui` is deliberately **not** mounted yet: it throws
 * `not implemented`, and #29 is rewriting it. When it lands, this returns
 * `<MainWindow environment={environment} />` and nothing else here changes.
 */
function App(): ReactElement {
  useEffect(() => {
    // After first paint, and not awaited: a launch that blocks on a socket has
    // handed the daemon a veto over the launch budget. StrictMode fires this
    // twice in development, which is harmless — `connect()` is idempotent while a
    // loop is running, and registration reports the existing status rather than
    // registering twice.
    void environment.start();
  }, []);

  return <main className="bg-terminal-background h-dvh" />;
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
