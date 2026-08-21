import type { Frame } from "./frame.ts";

/**
 * A bidirectional stream of frames.
 *
 * The one abstraction that makes a remote client possible without redesigning the
 * protocol. In v1 there are two implementations and both are local: the daemon's
 * Unix socket listener, and the desktop app's bridge through Tauri's IPC — a
 * WebView cannot open a Unix socket, so the Rust shell does it and relays frames.
 * A WebSocket implementation later makes a browser client a transport rather than
 * a rewrite.
 *
 * This is deliberately the *only* speculative generality in the protocol layer —
 * see docs/decisions/0016-daemon-protocol.md, which is honest about that being a
 * cost rather than pretending it is free, and
 * docs/decisions/0023-macos-first-portable.md for what it buys.
 */
export interface MessageTransport {
  /**
   * Frames as they arrive, in order.
   *
   * The sequence finishes when the peer disconnects cleanly, and throws when it
   * does not. Both are ordinary outcomes: a client quitting is not an error, and a
   * client crashing is not fatal to anyone else.
   */
  incoming(): AsyncIterable<Frame>;

  /**
   * Sends one frame.
   *
   * Back-pressure is the implementation's business, and it must be bounded: a
   * stalled peer may not grow a queue without limit, and dropping *coalesced
   * repaints* is safe in a way dropping terminal input never is. See
   * docs/performance.md § Terminal throughput and `BoundedQueue` in
   * `@janela/support`.
   */
  send(frame: Frame): Promise<void>;

  /** Closes the connection. Idempotent. */
  close(): Promise<void>;
}
