import type { TerminalID } from "@janela/core";
import type { ClientMessage, HandshakeRefusal, MessageTransport } from "@janela/protocol";

/**
 * A client's connection to `janelad`, and the mirrored state it produces.
 *
 * ## The one rule
 *
 * **The daemon is the truth; this is a mirror.** Nothing here computes state it
 * could ask for, and nothing writes state it did not receive. A client that infers
 * — "I sent input, so it must be running" — is guessing about a process in another
 * process. See docs/decisions/0015-daemon-owned-sessions.md § Rules.
 *
 * ## Disconnection is normal
 *
 * The daemon may be restarting, upgrading, or briefly gone. Views keep rendering the
 * last known mirror with `isStale` set; nothing blocks and nothing is discarded.
 * Terminals are unaffected either way — they are in the daemon, and they kept
 * running.
 *
 * ## Why this package knows nothing about Tauri
 *
 * It takes a `MessageTransport`. The desktop app supplies one backed by the Rust
 * shell's Unix socket, because a WebView cannot open one itself; a browser client
 * would supply one backed by a WebSocket. That is the seam that makes a browser
 * client a transport rather than a rewrite, and it is the only reason this package
 * is allowed to be as abstract as it is. See
 * docs/decisions/0023-macos-first-portable.md.
 */
export interface DaemonConnection {
  readonly status: ConnectionStatus;

  /** True when the mirror predates the current connection. */
  readonly isStale: boolean;

  /**
   * Connects, handshakes, and subscribes.
   *
   * Never called on the launch path in a way that blocks first paint: the window
   * draws its empty or last-known state and fills in when this resolves. See
   * docs/performance.md § Launch.
   */
  connect(): Promise<void>;

  /**
   * Sends a request and waits for its reply.
   *
   * Every mutation is a request with a reply, because fire-and-forget mutation is
   * how a mirror silently diverges from the truth.
   */
  request(message: ClientMessage): Promise<void>;

  /**
   * Keyboard input for an attached terminal.
   *
   * The one message with no reply: a round trip per keystroke would be absurd, and
   * the echo is the reply. Bytes, not a string — a client that decodes input to
   * UTF-8 and re-encodes it has corrupted every paste that was not valid UTF-8.
   */
  sendInput(bytes: Uint8Array, terminalID: TerminalID): void;

  /** Where repaint bytes for an attached terminal arrive. */
  onOutput(terminalID: TerminalID, handler: (bytes: Uint8Array) => void): () => void;

  disconnect(): Promise<void>;
}

export type ConnectionStatus =
  /** No connection yet, or deliberately disconnected. */
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  /** Connected, handshake complete, receiving state. */
  | { readonly kind: "connected" }
  /** Connection lost; retrying with backoff. The mirror is still rendered. */
  | { readonly kind: "reconnecting"; readonly attempt: number }
  /**
   * The daemon refused us and retrying will not help. Almost always a version
   * mismatch after an app update, which needs a human decision — never an automatic
   * daemon restart, because that kills live terminals.
   */
  | { readonly kind: "refused"; readonly refusal: HandshakeRefusal };

export function createConnection(options: {
  readonly transport: MessageTransport;
  readonly clientName: string;
}): DaemonConnection {
  void options;
  throw new Error(`not implemented: createConnection`);
}

// TODO: connect() — send Hello, await the daemon's, check compatibility, subscribe
// to state, then pump incoming frames into the stores. On failure, set
// `reconnecting` and retry with backoff — except for `refused`, which is terminal
// until the user acts.
//
// Reconnect is the part that is easy to get 80% right, so it must be tested with the
// daemon killed mid-frame: a half-read frame on the old connection must not corrupt
// the new one, and re-subscribing produces a full snapshot that replaces the mirror
// rather than merging into it. Re-attaching produces a fresh full repaint, which is
// why recovery needs no special case.
