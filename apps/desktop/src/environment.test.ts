import { describe, expect, test } from "bun:test";

import type { AbsolutePath, Instant, Session, SessionID, TerminalID } from "@janela/core";
import {
  encodeDaemonMessage,
  encodeFrame,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
} from "@janela/protocol";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";
import { createViewState } from "@janela/ui";
import type { Options } from "@tauri-apps/plugin-notification";

import { CLIENT_NAME, liveEnvironment } from "./environment.ts";
import type { NotificationPlugin } from "./notification-delivery.ts";
import type { BridgeInvoke } from "./transport.ts";

/** Branded ids, without a real generator: these never reach a daemon. */
const terminalID = (value: string): TerminalID => value as TerminalID;
const sessionID = (value: string): SessionID => value as SessionID;

/** The daemon's side of the handshake, which the client waits for before it settles. */
const DAEMON_HELLO = encodeFrame(
  encodeDaemonMessage({
    type: "hello",
    hello: {
      protocolVersion: PROTOCOL_VERSION,
      minimumSupported: MINIMUM_SUPPORTED_VERSION,
      clientName: "janelad",
    },
  }),
);

interface FakeShell {
  readonly invoke: BridgeInvoke;
  readonly commands: readonly string[];
  /** Hands the client one more frame, as the daemon would. */
  push(frame: Uint8Array): void;
}

/** One session, one terminal, named so a notification's title can be asserted. */
const SESSION: Session = {
  id: sessionID("s1"),
  name: "api server",
  directory: "/tmp/s1" as AbsolutePath,
  backing: { kind: "folder" },
  terminals: [
    {
      id: terminalID("t1"),
      title: "claude",
      startsAutomatically: false,
      role: { kind: "user" },
      createdAt: "2026-01-01T00:00:00.000Z" as Instant,
    },
  ],
  layout: { tabs: [], focusedTabIndex: 0 },
  accent: "none",
  createdAt: "2026-01-01T00:00:00.000Z" as Instant,
  lastActiveAt: "2026-01-01T00:00:00.000Z" as Instant,
  isPinned: false,
};

const SNAPSHOT = encodeFrame(
  encodeDaemonMessage({
    type: "state",
    update: {
      projects: [],
      sessions: [SESSION],
      terminalStates: { [terminalID("t1")]: { kind: "needsAttention" } },
      launchProfiles: [],
      launchProfileAvailability: {},
      isFullSnapshot: true,
    },
  }),
);

const ATTENTION = encodeFrame(
  encodeDaemonMessage({
    type: "attention",
    signal: {
      kind: { kind: "notification", body: "needs input" },
      terminalID: terminalID("t1"),
      sessionID: sessionID("s1"),
      id: "signal-1",
      occurredAt: "2026-01-01T00:00:10.000Z" as Instant,
    },
  }),
);

/**
 * Two terminals, on two tabs, with the *other* one focused.
 *
 * The single-terminal snapshot cannot prove a click moved focus: `repairLayout`
 * focuses the only terminal there is, so focusing it again is a no-op and the
 * assertion would pass on a click that did nothing.
 */
const TWO_TABS = encodeFrame(
  encodeDaemonMessage({
    type: "state",
    update: {
      projects: [],
      sessions: [
        {
          ...SESSION,
          terminals: [
            ...SESSION.terminals,
            {
              id: terminalID("t2"),
              title: "zsh",
              startsAutomatically: false,
              role: { kind: "user" },
              createdAt: "2026-01-01T00:00:00.000Z" as Instant,
            },
          ],
          layout: {
            tabs: [
              {
                root: { kind: "terminal", id: terminalID("t1") },
                focusedTerminalID: terminalID("t1"),
              },
              {
                root: { kind: "terminal", id: terminalID("t2") },
                focusedTerminalID: terminalID("t2"),
              },
            ],
            focusedTabIndex: 1,
          },
        },
      ],
      terminalStates: { [terminalID("t1")]: { kind: "needsAttention" } },
      launchProfiles: [],
      launchProfileAvailability: {},
      isFullSnapshot: true,
    },
  }),
);

/**
 * A later frame, used only as a marker.
 *
 * Frames are ordered, so a test that waits for this one has waited for everything
 * pushed before it — which is the only honest way to assert that a signal was
 * *processed* and produced nothing.
 */
const RENAMED = encodeFrame(
  encodeDaemonMessage({
    type: "state",
    update: {
      projects: [],
      sessions: [{ ...SESSION, name: "renamed" }],
      terminalStates: { [terminalID("t1")]: { kind: "needsAttention" } },
      launchProfiles: [],
      launchProfileAvailability: {},
      isFullSnapshot: true,
    },
  }),
);

interface RecordingPlugin extends NotificationPlugin {
  readonly sent: Options[];
  /** Each `removeActive` call, as the ids it was asked to withdraw. */
  readonly removed: number[][];
  click(notification: Options): void;
}

/** The plugin boundary, recorded. A test process has no notification centre. */
function recordingPlugin(): RecordingPlugin {
  const sent: Options[] = [];
  const removed: number[][] = [];
  let handler: ((notification: Options) => void) | undefined;
  return {
    sent,
    removed,
    click: (notification) => handler?.(notification),
    isPermissionGranted: () => Promise.resolve(true),
    requestPermission: () => Promise.resolve<NotificationPermission>("granted"),
    sendNotification: (options) => sent.push(options),
    removeActive: (ids) => {
      removed.push(ids.map((entry) => entry.id));
      return Promise.resolve();
    },
    onAction: (next) => {
      handler = next;
      return Promise.resolve(undefined);
    },
  };
}

/**
 * Yields until a condition the read pump satisfies holds.
 *
 * Microtasks, not a wall clock: every hop between the fake shell and the mirror is
 * a resolved promise, so there is no duration to wait out and nothing to flake.
 */
async function until(condition: () => boolean, attempts = 1_000): Promise<void> {
  if (condition()) return;
  if (attempts === 0) throw new Error("condition never held");
  await Promise.resolve();
  return until(condition, attempts - 1);
}

/**
 * A fake Tauri boundary that answers the handshake, then goes quiet.
 *
 * Quiet rather than closed: a connection that ended would send the client into
 * its reconnect loop, and these tests are about what the environment does
 * *around* a live connection.
 *
 * `bridge_close` resolves the parked `bridge_receive` with zero bytes, exactly as
 * the real shell does — that is what lets `incoming()` finish, and without it
 * `disconnect()` would wait for a pump that can never end.
 */
function fakeShell(overrides?: Record<string, () => unknown>): FakeShell {
  const commands: string[] = [];
  let greeted = false;
  let ended = false;
  let parked: ((buffer: ArrayBuffer) => void) | undefined;
  const queued: ArrayBuffer[] = [];

  const invoke = (async (command: string): Promise<unknown> => {
    commands.push(command);
    const override = overrides?.[command];
    if (override !== undefined) return override();
    switch (command) {
      case "bridge_connect":
        return 1;
      case "register_launch_agent":
        return "unsupported";
      case "bridge_receive": {
        // A poll after a close is routine — the generator is one await behind —
        // and the real shell answers an unknown id with an empty response.
        if (ended) return new ArrayBuffer(0);
        if (!greeted) {
          greeted = true;
          return DAEMON_HELLO.slice().buffer;
        }
        const next = queued.shift();
        if (next !== undefined) return next;
        const { promise, resolve } = Promise.withResolvers<ArrayBuffer>();
        parked = resolve;
        return promise;
      }
      case "bridge_close": {
        ended = true;
        parked?.(new ArrayBuffer(0));
        parked = undefined;
        return undefined;
      }
      default:
        return undefined;
    }
  }) as unknown as BridgeInvoke;

  return {
    invoke,
    commands,
    push(frame: Uint8Array): void {
      const buffer = frame.slice().buffer;
      if (parked === undefined) {
        queued.push(buffer);
        return;
      }
      const resolve = parked;
      parked = undefined;
      resolve(buffer);
    },
  };
}

describe("liveEnvironment", () => {
  test("construction touches no invoke", () => {
    const shell = fakeShell();

    const environment = liveEnvironment({ invoke: shell.invoke });

    // Laziness is a feature: nothing may talk to the shell before first paint,
    // because the window must draw before the daemon answers.
    expect(shell.commands).toEqual([]);
    expect(environment.connection.status).toEqual({ kind: "idle" });
    expect(environment.launchAgent.status).toBe("unknown");
  });

  test("start reports the shell's agent status", async () => {
    const shell = fakeShell({ register_launch_agent: () => "requires-approval" });
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.start();
    // The registration check is fired, not awaited, so its result lands a
    // microtask later than `connect()` resolving.
    await Promise.resolve();

    expect(environment.launchAgent.status).toBe("requires-approval");
  });

  test("a registration the shell cannot answer is `unavailable`, and the connection proceeds", async () => {
    const shell = fakeShell({
      register_launch_agent: () => {
        throw new Error("no such command");
      },
    });
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.start();
    await Promise.resolve();

    // Degraded mode is reachable and honest: a distinct status the UI can state,
    // and a connection that came up regardless.
    expect(environment.launchAgent.status).toBe("unavailable");
    expect(environment.connection.status.kind).toBe("connected");
  });

  test("an unrecognised status string is `unavailable` rather than assumed", async () => {
    const shell = fakeShell({ register_launch_agent: () => "something-new" });
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.start();
    await Promise.resolve();

    expect(environment.launchAgent.status).toBe("unavailable");
  });

  test("subscribers are notified when the agent status changes", async () => {
    const shell = fakeShell({ register_launch_agent: () => "registered" });
    const environment = liveEnvironment({ invoke: shell.invoke });
    let notifications = 0;
    environment.launchAgent.subscribe(() => (notifications += 1));

    await environment.start();
    await Promise.resolve();

    expect(notifications).toBe(1);
  });

  test("start connects and hands the daemon this client's name", async () => {
    const shell = fakeShell();
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.start();

    expect(shell.commands).toContain("bridge_connect");
    expect(CLIENT_NAME).toBe("janela-desktop");
  });

  test("stopBackgroundService disconnects before it asks launchd to stop", async () => {
    const shell = fakeShell();
    const environment = liveEnvironment({ invoke: shell.invoke });
    await environment.start();

    await environment.stopBackgroundService();

    // The client's reconnect loop kickstarts the daemon through the bridge on
    // every failed attempt, so a stop issued while it is still running would
    // restart the process the user just asked us to stop.
    const closed = shell.commands.indexOf("bridge_close");
    const stopped = shell.commands.indexOf("stop_background_service");
    expect(closed).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(closed);
    expect(environment.connection.status).toEqual({ kind: "idle" });
  });

  test("openLoginItemsSettings asks the shell, and nothing else", async () => {
    const shell = fakeShell();
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.launchAgent.openLoginItemsSettings();
    expect(shell.commands).toEqual(["open_login_items_settings"]);
  });

  test("an attention signal off the wire becomes a real notification", async () => {
    const shell = fakeShell();
    const plugin = recordingPlugin();
    const environment = liveEnvironment({
      invoke: shell.invoke,
      plugin,
      isApplicationActive: () => false,
    });
    await environment.start();

    shell.push(SNAPSHOT);
    shell.push(ATTENTION);
    await until(() => plugin.sent.length > 0);

    // The whole path: bridge → frame → mirror → policy → adapter → plugin. The
    // names come from the mirror, which is the only reason the snapshot is here.
    expect(plugin.sent[0]?.title).toBe("api server — claude");
    expect(plugin.sent[0]?.body).toBe("needs input");
    expect(plugin.sent[0]?.extra).toEqual({
      sessionID: sessionID("s1"),
      terminalID: terminalID("t1"),
    });
  });

  test("a click selects the session and focuses the pane the view installed", async () => {
    const shell = fakeShell();
    const plugin = recordingPlugin();
    const environment = liveEnvironment({
      invoke: shell.invoke,
      plugin,
      isApplicationActive: () => false,
      activateWindow: () => Promise.resolve(),
    });
    const focused: TerminalID[] = [];
    environment.focus.install((id) => focused.push(id));
    await environment.start();

    shell.push(SNAPSHOT);
    shell.push(ATTENTION);
    await until(() => plugin.sent.length > 0);
    const posted = plugin.sent[0];
    if (posted === undefined) throw new Error("nothing posted");
    plugin.click(posted);

    expect(environment.sessions.selection).toBe(sessionID("s1"));
    expect(focused).toEqual([terminalID("t1")]);
  });

  test("a click reaches the real ViewState and focuses the mounted surface", async () => {
    const shell = fakeShell();
    const plugin = recordingPlugin();
    const environment = liveEnvironment({
      invoke: shell.invoke,
      plugin,
      isApplicationActive: () => false,
      activateWindow: () => Promise.resolve(),
    });
    // The real seam #37 shipped, not a stand-in: `focusTerminal` is also what the
    // menu chords and the jump list call, so this proves the click shares one
    // focus mechanism with them rather than owning a second.
    const view = createViewState(environment.sessions);
    environment.focus.install((id) => {
      view.focusTerminal(id);
    });
    const focusedSurface: string[] = [];
    const surface: TerminalSurfaceHandle = {
      feed: () => {},
      clearViewport: () => {},
      selectedText: () => undefined,
      focus: () => focusedSurface.push("focus"),
      viewport: () => undefined,
    };
    view.registerSurface(terminalID("t1"), surface);
    await environment.start();

    shell.push(TWO_TABS);
    shell.push(ATTENTION);
    await until(() => plugin.sent.length > 0);
    const posted = plugin.sent[0];
    if (posted === undefined) throw new Error("nothing posted");
    plugin.click(posted);

    expect(environment.sessions.selection).toBe(sessionID("s1"));
    expect(focusedSurface).toEqual(["focus"]);
    // And in the layout, so the pane stays focused across a re-render and the tab
    // the signalling terminal lives on is the one on screen. The snapshot arrived
    // focused on tab 1; the click moved it to tab 0.
    const local = view.layouts.get(sessionID("s1"))?.local;
    expect(local?.focusedTabIndex).toBe(0);
    expect(local?.tabs[0]?.focusedTerminalID).toBe(terminalID("t1"));
    // And withdrawn: the user is looking at it now.
    const id = posted.id;
    if (id === undefined) throw new Error("posted without an id to withdraw by");
    expect(plugin.removed).toEqual([[id]]);
  });

  test("the terminal the view reports as focused is not interrupted", async () => {
    const shell = fakeShell();
    const plugin = recordingPlugin();
    const environment = liveEnvironment({
      invoke: shell.invoke,
      plugin,
      isApplicationActive: () => true,
    });
    await environment.start();

    shell.push(SNAPSHOT);
    await until(() => environment.sessions.sessions.length > 0);
    environment.sessions.selection = sessionID("s1");
    environment.focus.report(terminalID("t1"));
    shell.push(ATTENTION);
    shell.push(RENAMED);
    // The marker proves the signal was consumed rather than still in flight: an
    // assertion that nothing happened is worthless if nothing has happened yet.
    await until(() => environment.sessions.sessions[0]?.name === "renamed");

    expect(plugin.sent).toEqual([]);
    // The in-app channel is untouched by the refusal: the badge is the daemon's
    // `TerminalState`, and the sidebar needs no permission.
    expect(environment.sessions.terminalStates[terminalID("t1")]).toEqual({
      kind: "needsAttention",
    });
  });
});
