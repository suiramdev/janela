/**
 * The web entry point.
 *
 * Mounts `MainWindow` and starts the connection *after* first paint. Deliberately
 * the only file here that touches the DOM directly.
 */

import { info } from "@tauri-apps/plugin-log";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

// TODO: Mount @janela/ui's MainWindow with the environment from `environment.ts`,
// then call `start()` in an effect — not before render, and not awaited.
//
// Also install the log sink (`setLogSink` from @janela/support) over Tauri's log
// plugin, so a client log and a daemon log carry the same shapes and can be read
// side by side.

/** The element the app mounts into. Declared here so `index.html` and this agree. */
export const ROOT_ELEMENT_ID = "janela-root";

const container = document.getElementById(ROOT_ELEMENT_ID);
if (container === null) throw new Error(`index.html has no #${ROOT_ELEMENT_ID}`);

createRoot(container).render(
  <StrictMode>
    <main className="bg-terminal-background h-dvh" />
  </StrictMode>,
);

// Launch budget instrument, until @janela/support's `begin("launch")` exists:
// navigation start → first animation frame, read next to the shell's own
// "window loaded" line. Fire-and-forget; nothing on the launch path awaits it.
requestAnimationFrame(() => {
  void info(`first frame ${Math.round(performance.now())} ms after navigation`);
});
