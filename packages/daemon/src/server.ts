import type { MessageTransport, StateUpdate } from "@janela/protocol";
import type { ProjectService, SessionService, StateObserving } from "@janela/session";
import type { TerminalRegistry } from "@janela/terminal";

import type { PeerCredential } from "./endpoint.ts";

/**
 * Accepts connections and fans state out to them.
 *
 * Deliberately thin. Everything a message *means* lives in `@janela/session`; this
 * package owns connections, subscriptions and the handshake, and nothing else. If
 * product logic appears here it is in the wrong package, and the test for that is
 * simple: `@janela/session` must stay usable with no socket at all.
 */
export interface DaemonServer extends StateObserving {
  /**
   * Serves until the signal aborts.
   *
   * @param listener An already-bound listener. In production this wraps the
   *   descriptor launchd handed us, because launchd owns the socket and we never
   *   bind a path ourselves (docs/decisions/0017-daemon-lifecycle.md).
   * @throws Only when the *listener itself* fails — the socket vanishing, or a
   *   descriptor we cannot accept on. A failure on any single connection is handled
   *   and logged rather than thrown, because one client sending nonsense must never
   *   take down a daemon holding another client's terminals.
   */
  serve(listener: ConnectionListening, signal: AbortSignal): Promise<void>;

  /**
   * Broadcasts a state change to every subscriber.
   *
   * Called by `@janela/session` through `StateObserving`, so the brain never learns
   * that sockets exist.
   */
  publish(update: StateUpdate): Promise<void>;

  /**
   * Whether the daemon may exit.
   *
   * False while any terminal is live, however many clients are connected —
   * including none. That asymmetry is the entire feature: the daemon exists to
   * outlive clients, not to serve them.
   */
  canExitWhenIdle(): boolean;

  /** Connected clients, for the "what is running" story on version skew. */
  readonly connectionCount: number;
}

/**
 * Something that yields connections.
 *
 * An interface so tests can drive the server over an in-process pair while
 * production uses a real socket — and so a future network listener is an
 * implementation rather than a fork inside `serve`.
 */
export interface ConnectionListening {
  accept(): AsyncIterable<AcceptedConnection>;
  close(): Promise<void>;
}

export interface AcceptedConnection {
  readonly transport: MessageTransport;
  /** What the OS says about the peer. Checked before the handshake is read. */
  readonly credential: PeerCredential;
}

export function createDaemonServer(dependencies: {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly terminals: TerminalRegistry;
}): DaemonServer {
  void dependencies;
  throw new Error(`not implemented: createDaemonServer`);
}

// TODO: serve() — the accept loop. Per connection: check the peer uid, exchange
// Hello, then run a task that reads frames until the peer goes away.
//
// A connection failing — bad handshake, malformed frame, peer crash — must never
// take down the daemon or another connection. A refusal in particular is *not*
// fatal: the daemon keeps running and keeps holding the user's terminals, because
// the alternative is an app update killing an agent mid-task.

// TODO: publish() — fan out to subscribers whose scope matches, each with its own
// bounded queue. A stalled client must not slow the others.
//
// The two queues are not the same and must not share a policy: coalesced repaints
// may drop their oldest entry, because a newer frame supersedes it and the next
// full repaint recovers anything lost. Control frames and terminal input may not
// drop anything, ever. `BoundedQueue` in @janela/support carries that distinction;
// use it rather than reinventing it here.
