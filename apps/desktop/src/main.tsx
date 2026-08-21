/**
 * The web entry point.
 *
 * Mounts `MainWindow` and starts the connection *after* first paint. Deliberately
 * the only file here that touches the DOM directly.
 */

// TODO: Mount @janela/ui's MainWindow with the environment from `environment.ts`,
// then call `start()` in an effect — not before render, and not awaited.
//
// Also install the log sink (`setLogSink` from @janela/support) over Tauri's log
// plugin, so a client log and a daemon log carry the same shapes and can be read
// side by side.

/** The element the app mounts into. Declared here so `index.html` and this agree. */
export const ROOT_ELEMENT_ID = "janela-root";
