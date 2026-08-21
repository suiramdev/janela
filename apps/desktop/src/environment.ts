import type {
  AttentionDelivering,
  DaemonConnection,
  ProjectStore,
  SessionStore,
} from "@janela/client";

/**
 * The composition root.
 *
 * Everything is constructed here, once, and injected downward. There is no service
 * locator, no singleton graph, and no module-level mutable state. If a type needs a
 * dependency, it takes it — which is also what makes the whole graph substitutable in
 * tests.
 *
 * ## What this process is
 *
 * A **client**. It renders, it delivers notifications, and it asks `janelad` to do
 * things. It does not own a PTY, a database, or a git checkout — none of those
 * packages are even linked, so it could not if it tried. See
 * docs/decisions/0015-daemon-owned-sessions.md.
 *
 * ## Launch budget
 *
 * Process start to an interactive window, and **the window paints before the daemon
 * answers**. Connecting is started here and awaited nowhere: a launch that blocks on
 * a socket has handed the daemon a veto over the launch budget, which is the coupling
 * the two-process split exists to remove. See docs/performance.md § Launch — and note
 * that the budget itself was revised for a WebView client in
 * docs/decisions/0023-macos-first-portable.md rather than quietly dropped.
 */
export interface AppEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;
  readonly attention: AttentionDelivering;

  /** Connects to the daemon. Called after first paint, never before it. */
  start(): Promise<void>;
}

/**
 * Builds the production graph.
 *
 * Note how little happens here: no database to open, no migration that could fail on
 * the launch path. Those live in the daemon, where a failure surfaces as a connection
 * that does not come up rather than an app that will not launch.
 */
export function liveEnvironment(): AppEnvironment {
  throw new Error(`not implemented: liveEnvironment`);
}

// TODO: Build the transport (see `transport.ts`) and ensure the daemon is
// registered as a launch agent if it is not already.
//
// Registration can report "requires approval", and that is a supported state, not an
// error: the app runs in a degraded mode — terminals that die when the app quits —
// and says so plainly, with a link to the right settings pane. Refusing to work at
// all would be worse. See docs/decisions/0017-daemon-lifecycle.md § Registration.
