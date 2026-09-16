import { describe, expect, test } from "bun:test";

import { absolutePath, identifier, instant, type Session, type TerminalID } from "@janela/core";
import {
  encodeDaemonMessage,
  encodeFrame,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
} from "@janela/protocol";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";
import { createViewState } from "@janela/ui";
import { PluginListener } from "@tauri-apps/api/core";
import type { Options } from "@tauri-apps/plugin-notification";

import type { NotificationPlugin } from "./adapters/notification-delivery.ts";
import type { BridgeInvoke } from "./adapters/transport.ts";
import { CLIENT_NAME, liveEnvironment } from "./environment.ts";

type ShellAnswer = number | string | ArrayBuffer | undefined;

type ShellOverrides = Readonly<Record<string, () => ShellAnswer>>;

interface FakeShell {
  readonly invoke: BridgeInvoke;
  readonly commands: readonly string[];
  push(frame: Uint8Array): void;
}

interface RecordingPlugin extends NotificationPlugin {
  readonly sent: Options[];
  readonly removed: number[][];
  click(notification: Options): void;
}

const SESSION_ID = identifier<"Session">(crypto.randomUUID());

const TERMINAL_ID = identifier<"Terminal">(crypto.randomUUID());

const SECOND_TERMINAL_ID = identifier<"Terminal">(crypto.randomUUID());

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

const SESSION: Session = {
  id: SESSION_ID,
  name: "api server",
  directory: absolutePath("/tmp/s1"),
  backing: { kind: "folder" },
  terminals: [
    {
      id: TERMINAL_ID,
      title: "claude",
      startsAutomatically: false,
      role: { kind: "user" },
      createdAt: instant("2026-01-01T00:00:00.000Z"),
    },
  ],
  layout: { tabs: [], focusedTabIndex: 0 },
  accent: "none",
  createdAt: instant("2026-01-01T00:00:00.000Z"),
  lastActiveAt: instant("2026-01-01T00:00:00.000Z"),
  isPinned: false,
};

const SNAPSHOT = encodeFrame(
  encodeDaemonMessage({
    type: "state",
    update: {
      projects: [],
      sessions: [SESSION],
      terminalStates: { [TERMINAL_ID]: { kind: "needsAttention" } },
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
      terminalID: TERMINAL_ID,
      sessionID: SESSION_ID,
      id: "signal-1",
      occurredAt: instant("2026-01-01T00:00:10.000Z"),
    },
  }),
);

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
              id: SECOND_TERMINAL_ID,
              title: "zsh",
              startsAutomatically: false,
              role: { kind: "user" },
              createdAt: instant("2026-01-01T00:00:00.000Z"),
            },
          ],
          layout: {
            tabs: [
              {
                root: { kind: "terminal", id: TERMINAL_ID },
                focusedTerminalID: TERMINAL_ID,
              },
              {
                root: { kind: "terminal", id: SECOND_TERMINAL_ID },
                focusedTerminalID: SECOND_TERMINAL_ID,
              },
            ],
            focusedTabIndex: 1,
          },
        },
      ],
      terminalStates: { [TERMINAL_ID]: { kind: "needsAttention" } },
      launchProfiles: [],
      launchProfileAvailability: {},
      isFullSnapshot: true,
    },
  }),
);

const RENAMED = encodeFrame(
  encodeDaemonMessage({
    type: "state",
    update: {
      projects: [],
      sessions: [{ ...SESSION, name: "renamed" }],
      terminalStates: { [TERMINAL_ID]: { kind: "needsAttention" } },
      launchProfiles: [],
      launchProfileAvailability: {},
      isFullSnapshot: true,
    },
  }),
);

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

      return Promise.resolve(new PluginListener("notification", "onAction", 0));
    },
  };
}

async function until(condition: () => boolean, attempts = 1_000): Promise<void> {
  if (condition()) return;

  if (attempts === 0) throw new Error("condition never held");

  await Promise.resolve();

  return until(condition, attempts - 1);
}

function fakeShell(overrides: ShellOverrides = {}): FakeShell {
  const commands: string[] = [];
  let greeted = false;
  let ended = false;
  let parked: ((buffer: ArrayBuffer) => void) | undefined;
  const queued: ArrayBuffer[] = [];

  const answer = async (command: string): Promise<ShellAnswer> => {
    commands.push(command);
    const override = overrides[command];

    if (override !== undefined) return override();

    if (command === "bridge_connect") return 1;

    if (command === "register_launch_agent") return "unsupported";

    if (command === "bridge_receive") {
      if (ended) return new ArrayBuffer(0);

      if (!greeted) {
        greeted = true;

        return DAEMON_HELLO.slice().buffer;
      }

      const next = queued.shift();

      if (next !== undefined) return next;

      const { promise, resolve } = Promise.withResolvers<ArrayBuffer>();
      parked = resolve;

      return await promise;
    }

    if (command === "bridge_close") {
      ended = true;
      parked?.(new ArrayBuffer(0));
      parked = undefined;
    }

    return undefined;
  };

  const invoke: BridgeInvoke = <Answer>(command: string): Promise<Answer> =>
    answer(command) as Promise<Answer>;

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

    expect(shell.commands).toEqual([]);
    expect(environment.connection.status).toEqual({ kind: "idle" });
    expect(environment.launchAgent.status).toBe("unknown");
  });

  test("start reports the shell's agent status", async () => {
    const shell = fakeShell({ register_launch_agent: () => "requires-approval" });
    const environment = liveEnvironment({ invoke: shell.invoke });

    await environment.start();
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

    expect(plugin.sent[0]?.title).toBe("api server — claude");
    expect(plugin.sent[0]?.body).toBe("needs input");
    expect(plugin.sent[0]?.extra).toEqual({
      sessionID: SESSION_ID,
      terminalID: TERMINAL_ID,
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

    expect(environment.sessions.selection).toBe(SESSION_ID);
    expect(focused).toEqual([TERMINAL_ID]);
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

    const view = createViewState(environment.sessions);
    environment.focus.install((id) => {
      view.focusTerminal(id);
    });
    const focusedSurface: string[] = [];

    const surface: TerminalSurfaceHandle = {
      feed: () => {},
      clearViewport: () => {},
      selectedText: () => undefined,
      paste: () => {},
      focus: () => focusedSurface.push("focus"),
      viewport: () => undefined,
    };

    view.registerSurface(TERMINAL_ID, surface);
    await environment.start();

    shell.push(TWO_TABS);
    shell.push(ATTENTION);
    await until(() => plugin.sent.length > 0);
    const posted = plugin.sent[0];

    if (posted === undefined) throw new Error("nothing posted");

    plugin.click(posted);

    expect(environment.sessions.selection).toBe(SESSION_ID);
    expect(focusedSurface).toEqual(["focus"]);

    const local = view.layouts.get(SESSION_ID)?.local;

    expect(local?.focusedTabIndex).toBe(0);
    expect(local?.tabs[0]?.focusedTerminalID).toBe(TERMINAL_ID);

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
    environment.sessions.selection = SESSION_ID;
    environment.focus.report(TERMINAL_ID);
    shell.push(ATTENTION);
    shell.push(RENAMED);
    await until(() => environment.sessions.sessions[0]?.name === "renamed");

    expect(plugin.sent).toEqual([]);
    expect(environment.sessions.terminalStates[TERMINAL_ID]).toEqual({
      kind: "needsAttention",
    });
  });
});
