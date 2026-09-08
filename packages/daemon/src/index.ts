/**
 * `@janela/daemon` — layer 6, daemon side. Listener, connections, subscriptions.
 *
 * Thin on purpose: what a message *means* belongs in `@janela/session`. This is the
 * only package that knows a socket exists: it never binds and never chooses a path,
 * so `apps/daemon` names `node:net` too, for the bind alone (ADR 0017, amended).
 */

export * from "./dispatch.ts";
export * from "./endpoint.ts";
export * from "./frame-loop.ts";
export * from "./listener.ts";
export * from "./server.ts";
