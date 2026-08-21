/**
 * `@janela/client` — layer 6, client side.
 *
 * The connection, the mirrored state the view layer reads, and the attention policy
 * — which lives here rather than in the daemon because only a client knows what is
 * focused.
 *
 * **Transport-agnostic on purpose.** It takes a `MessageTransport` and never learns
 * whether the bytes travel over a Unix socket via Tauri's IPC or over a WebSocket
 * from a browser. That is the single seam that makes a web client reachable, and it
 * is why this package imports nothing platform-specific — no Tauri, no DOM, no
 * React. See docs/decisions/0023-macos-first-portable.md.
 */

export * from "./attention-policy.ts";
export * from "./connection.ts";
export * from "./stores.ts";
