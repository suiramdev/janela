import type { MessageTransport } from "@janela/protocol";

/**
 * The Tauri-IPC transport.
 *
 * ## Why this exists at all
 *
 * **A WebView cannot open a Unix socket.** So the Rust shell opens it, and this
 * relays frames across Tauri's IPC boundary: commands for client → daemon, events for
 * daemon → client. From `@janela/client`'s point of view it is just a
 * `MessageTransport`, which is the entire reason that package is transport-agnostic.
 *
 * This file is the concrete cost of the Tauri decision and the concrete proof the
 * seam is real: a browser client replaces exactly this file with a WebSocket
 * implementation and changes nothing above it. See
 * docs/decisions/0023-macos-first-portable.md.
 *
 * ## The one performance rule
 *
 * Terminal frames are the hot path and they now cross an extra boundary. Tauri's IPC
 * can carry raw bytes without a JSON round-trip, and it must: base64 through IPC
 * would inflate every repaint by a third and add two passes per frame, which is
 * exactly the mistake ADR 0016 refused to make on the socket. Measure this; the
 * budget is in docs/performance.md § Terminal throughput.
 */
export function tauriTransport(): MessageTransport {
  throw new Error(`not implemented: tauriTransport`);
}

// TODO: Implement over Tauri's IPC. Three things to get right:
//
//   1. **Bytes, not strings, in both directions.** Use the raw-payload path, and
//      assert it in a test that pushes invalid UTF-8 through and compares bytes.
//   2. **Back-pressure.** The Rust side must not queue repaints without bound when
//      the WebView is busy. Coalesced repaints may drop their oldest entry; control
//      frames and input may not. `BoundedQueue` in @janela/support carries that
//      distinction.
//   3. **Reconnection is the shell's business, not this file's.** The Rust side owns
//      the socket and its lifecycle; this transport's `incoming` finishes when the
//      shell says the connection ended, and `@janela/client` retries by asking for a
//      new one. Two retry loops in two languages is one too many.
