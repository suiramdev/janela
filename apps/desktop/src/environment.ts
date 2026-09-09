import {
  createAttentionPolicy,
  createConnection,
  createStores,
  routeAttention,
  type AttentionDelivering,
  type DaemonConnection,
  type ProjectStore,
  type SessionStore,
} from "@janela/client";
import type { TerminalID } from "@janela/core";
import { log } from "@janela/support";
import { invoke } from "@tauri-apps/api/core";

import { createNotificationDelivery, type NotificationPlugin } from "./notification-delivery.ts";
import { openTauriTransport, type BridgeInvoke } from "./transport.ts";

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

/** What the daemon logs this client as. Appears in its "connected" record. */
export const CLIENT_NAME = "janela-desktop";

/**
 * What the app knows about the LaunchAgent.
 *
 * The same closed set the Rust side returns as a string, plus two the app owns:
 * `"unknown"` before the check has answered, and `"unavailable"` when the invoke
 * itself failed.
 */
export type LaunchAgentStatus =
  /** Not asked yet. The state at first paint, and never an error. */
  | "unknown"
  /** No `.app` bundle: a development build, with nothing to register. */
  | "unsupported"
  /** launchd owns the daemon. Terminals survive the app quitting. */
  | "registered"
  /**
   * Registered, and waiting for the user in Login Items & Extensions.
   *
   * A **supported state, not an error**: the app works, terminals die when it
   * quits, and it says so plainly with a link to the settings pane. Refusing to
   * work at all would be worse. See docs/decisions/0017-daemon-lifecycle.md
   * § Registration.
   */
  | "requires-approval"
  /** The sidecar is missing beside the executable: a damaged install. */
  | "not-found"
  /** The shell could not answer. Degraded, and honest about it. */
  | "unavailable";

export interface LaunchAgentState {
  readonly status: LaunchAgentStatus;
  subscribe(listener: () => void): () => void;
  /** Opens System Settings at Login Items & Extensions. */
  openLoginItemsSettings(): Promise<void>;
}

/**
 * The two directions pane focus travels.
 *
 * Both halves are the view's to call, which is why they are here rather than on
 * `ClientEnvironment`: the app is the one that needs the answer, and the app is the
 * one that needs to ask.
 */
export interface TerminalFocus {
  /**
   * The view reports which pane has focus, or `undefined` when none does.
   *
   * This is `AttentionContext.focusedTerminalID` — the fact that decides whether a
   * signal is "the user is staring at it" or "the user is elsewhere".
   */
  report(id: TerminalID | undefined): void;

  /**
   * The view installs the function that moves focus, and gets a disposer back.
   *
   * Called by a notification click, which must land on the terminal that signalled
   * (ADR 0011). In `main.tsx` this is `ViewState.focusTerminal` (#37) — **the**
   * pane-focus entry point, shared with the menu chords and the jump list, so a
   * click is not a second focus mechanism that can disagree with them.
   *
   * It stays an installed function rather than an import because `liveEnvironment`
   * must not depend on `@janela/ui`: the composition root is about the daemon
   * connection, and a graph that needs a React tree to construct is not one a
   * headless test can build. Until the view installs one, a click selects the
   * session and stops there.
   */
  install(focus: (id: TerminalID) => void): () => void;
}

export interface AppEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;
  readonly attention: AttentionDelivering;
  readonly launchAgent: LaunchAgentState;
  readonly focus: TerminalFocus;

  /** Connects to the daemon. Called after first paint, never before it. */
  start(): Promise<void>;

  /**
   * Hangs up every terminal the daemon holds and leaves it down.
   *
   * **The UI must state that cost before calling this.** Terminating a user's
   * terminals is only ever their explicit choice (non-negotiable #7).
   */
  stopBackgroundService(): Promise<void>;
}

/**
 * Builds the production graph.
 *
 * Note how little happens here: no database to open, no migration that could fail on
 * the launch path, and **no invoke at all**. Those live in the daemon, where a
 * failure surfaces as a connection that does not come up rather than an app that
 * will not launch.
 */
export function liveEnvironment(deps?: {
  readonly invoke?: BridgeInvoke;
  readonly plugin?: NotificationPlugin;
  readonly activateWindow?: () => Promise<void>;
  /** Whether this window is frontmost. Injected because a test has no window. */
  readonly isApplicationActive?: () => boolean;
}): AppEnvironment {
  const invokeFn = deps?.invoke ?? invoke;
  const { projects, sessions, mirror } = createStores();

  const connection = createConnection({
    // A factory, called once per attempt: the retry loop, the backoff and the
    // re-subscribe are `@janela/client`'s, and the shell makes one connect
    // attempt per call and never retries (#28, #30).
    openTransport: () => openTauriTransport(invokeFn),
    clientName: CLIENT_NAME,
    mirror,
    log: log("protocol"),
  });

  /**
   * The view's pane focus, as the app sees it: one value it reads and one function
   * it calls. Both start empty, and a click before the view has mounted simply
   * selects the session.
   */
  let focusedTerminal: TerminalID | undefined;
  let focuser: ((id: TerminalID) => void) | undefined;
  const focus: TerminalFocus = {
    report(id: TerminalID | undefined): void {
      focusedTerminal = id;
    },
    install(next: (id: TerminalID) => void): () => void {
      focuser = next;
      return () => {
        if (focuser === next) focuser = undefined;
      };
    },
  };

  const attention = createNotificationDelivery({
    ...(deps?.plugin === undefined ? {} : { plugin: deps.plugin }),
    ...(deps?.activateWindow === undefined ? {} : { activateWindow: deps.activateWindow }),
    log: log("app"),
    // The store half of a click. The window half is the adapter's, because raising
    // it is a shell capability and this root holds no Tauri API of its own.
    onActivate: (target) => {
      sessions.selection = target.sessionID;
      focuser?.(target.terminalID);
    },
  });

  // Subscribed at construction, not in `start()`: registering a handler spawns
  // nothing and reads nothing, and a signal cannot arrive before the connection
  // does. It lives as long as the process, so nothing calls `stop()`.
  routeAttention({
    source: connection,
    sessions,
    policy: createAttentionPolicy(),
    delivery: attention,
    // `document.hasFocus()` is the browser's answer to "is this window frontmost",
    // and it is synchronous — the policy is consulted on the signal path.
    isApplicationActive: deps?.isApplicationActive ?? ((): boolean => document.hasFocus()),
    focusedTerminalID: () => focusedTerminal,
    log: log("app"),
  });

  const appLog = log("app");
  let status: LaunchAgentStatus = "unknown";
  const agentListeners = new Set<() => void>();
  const setStatus = (next: LaunchAgentStatus): void => {
    if (next === status) return;
    status = next;
    for (const listener of agentListeners) listener();
  };
  /**
   * Records the settled status, once.
   *
   * Logged because it is the state a bug report needs and the UI's own copy
   * cannot carry: "terminals die when you quit" and "registered" look identical
   * in a screenshot of an empty window.
   */
  const settle = (next: LaunchAgentStatus): void => {
    appLog.info("launch agent", { status: next });
    setStatus(next);
  };

  const launchAgent: LaunchAgentState = {
    get status(): LaunchAgentStatus {
      return status;
    },
    subscribe(listener: () => void): () => void {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    async openLoginItemsSettings(): Promise<void> {
      await invokeFn<void>("open_login_items_settings");
    },
  };

  return {
    projects,
    sessions,
    connection,
    attention,
    launchAgent,
    focus,

    start(): Promise<void> {
      // Fired, not awaited. Registration talks to `smd`, which can take a moment
      // and can ask the user for approval; a launch that waited for it would have
      // handed the launch budget to a system daemon.
      void invokeFn<string>("register_launch_agent").then(
        (reported) => settle(asLaunchAgentStatus(reported)),
        () => settle("unavailable"),
      );
      // Resolves when the first attempt settles and never rejects: the outcome is
      // `connection.status`, which the views are already subscribed to.
      return connection.connect();
    },

    async stopBackgroundService(): Promise<void> {
      // Disconnect **first**. The client's own reconnect loop runs `launchctl
      // kickstart` through the bridge on every failed attempt, so stopping the
      // daemon while it is running would restart the process the user just asked
      // us to stop.
      await connection.disconnect();
      await invokeFn<void>("stop_background_service");
    },
  };
}

/** The shell's string, narrowed. Anything unrecognised is honest rather than assumed. */
function asLaunchAgentStatus(reported: string): LaunchAgentStatus {
  switch (reported) {
    case "unsupported":
    case "registered":
    case "requires-approval":
    case "not-found":
      return reported;
    default:
      return "unavailable";
  }
}
