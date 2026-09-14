/**
 * `@janela/protocol` — layer 2. The vocabulary the two processes share.
 *
 * Frames, messages, handshake, and the transport seam. Pure and JSON-encodable,
 * with no idea how either side is implemented. Changing anything here is a
 * wire-compatibility decision.
 *
 * Note what this package deliberately does not know: that a Unix socket exists,
 * that one of its peers is a WebView, or that the daemon holds a database. It is
 * the widest part of the design and the thinnest part of the code.
 */

export * from "./branch-overview.ts";
export * from "./frame.ts";
export * from "./handshake.ts";
export * from "./message-coder.ts";
export * from "./message.ts";
export * from "./removal-plan.ts";
export * from "./transport.ts";
