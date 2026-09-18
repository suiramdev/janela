import { describe, expect, test } from "bun:test";

import type { AttentionDelivering, AttentionEvent } from "@janela/client";
import type { Instant, SessionID, TerminalID } from "@janela/core";
import type { AttentionKind, AttentionSignal } from "@janela/protocol";
import type { LogRecord, Logger } from "@janela/support";
import { PluginListener } from "@tauri-apps/api/core";
import type { Options } from "@tauri-apps/plugin-notification";

import {
  createNotificationDelivery,
  notificationContent,
  MAXIMUM_IN_FLIGHT_DELIVERIES,
  MAXIMUM_OUTSTANDING_NOTIFICATIONS,
  type AttentionTarget,
  type NotificationPlugin,
} from "./notification-delivery.ts";

interface Recorded {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields?: LogRecord["fields"];
}

interface FakePlugin extends NotificationPlugin {
  readonly sent: Options[];
  readonly removed: number[][];
  readonly asked: string[];
  alreadyGranted: boolean;
  response: NotificationPermission;
  removalFails: boolean;
  listenerFails: boolean;
  gate?: { readonly promise: Promise<void>; open(): void };
  click(notification: Options): void;
}

interface DeliveryInput {
  readonly signal: AttentionSignal;
  readonly sessionName: string;
  readonly terminalTitle: string;
}

interface RecordingLogger {
  readonly log: Logger;
  readonly records: Recorded[];
  text(): string;
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

interface DeliveryOverrides {
  readonly onActivate?: ((target: AttentionTarget) => void) | undefined;
  readonly activateWindow?: (() => Promise<void>) | undefined;
  readonly playSound?: ((event: AttentionEvent) => void) | undefined;
  readonly log?: Logger | undefined;
}

const SESSION = "s1" as SessionID;

const OTHER = "s2" as SessionID;

const TERMINAL = "t1" as TerminalID;

const FAKE_LISTENER = new PluginListener("notification", "onAction", 0);

const SECRET_BODY = "BODY-4c7e01";

const SECRET_TITLE = "TITLE-b9d1f2";

const SECRET_SESSION_NAME = "SESSION-1de9c4";

const SECRET_TERMINAL_TITLE = "TERMINAL-7ac35b";

const NOTIFICATION: AttentionKind = { kind: "notification", body: SECRET_BODY };

function signal(kind: AttentionKind, session: SessionID = SESSION): AttentionSignal {
  return {
    kind,
    terminalID: TERMINAL,
    sessionID: session,
    id: `signal-${session}`,
    occurredAt: "2026-01-01T00:00:00.000Z" as Instant,
  };
}

function input(kind: AttentionKind, session: SessionID = SESSION): DeliveryInput {
  return { signal: signal(kind, session), sessionName: "api server", terminalTitle: "claude" };
}

function recordingLogger(): RecordingLogger {
  const records: Recorded[] = [];

  const at =
    (level: Recorded["level"]) =>
    (message: string, fields: LogRecord["fields"] = undefined): void => {
      records.push(fields === undefined ? { level, message } : { level, message, fields });
    };

  return {
    log: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
    text: () => JSON.stringify(records),
  };
}

function fakePlugin(): FakePlugin {
  const sent: Options[] = [];
  const removed: number[][] = [];
  const asked: string[] = [];
  let handler: ((notification: Options) => void) | undefined;

  const plugin: FakePlugin = {
    sent,
    removed,
    asked,
    alreadyGranted: true,
    response: "granted",
    removalFails: false,
    listenerFails: false,
    click(notification: Options): void {
      handler?.(notification);
    },
    async isPermissionGranted(): Promise<boolean> {
      asked.push("isPermissionGranted");
      await plugin.gate?.promise;

      return plugin.alreadyGranted;
    },
    async requestPermission(): Promise<NotificationPermission> {
      asked.push("requestPermission");

      return plugin.response;
    },
    sendNotification(options: Options): void {
      sent.push(options);
    },
    async removeActive(notifications: { id: number }[]): Promise<void> {
      if (plugin.removalFails) throw new Error("command not found");

      removed.push(notifications.map((entry) => entry.id));
    },
    async onAction(next: (notification: Options) => void): Promise<PluginListener> {
      if (plugin.listenerFails) throw new Error("command not found");

      handler = next;

      return FAKE_LISTENER;
    },
  };

  return plugin;
}

function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { promise, open: () => resolve() };
}

function delivery(plugin: FakePlugin, overrides: DeliveryOverrides = {}) {
  const activated: AttentionTarget[] = [];
  const raised: number[] = [];

  const adapter = createNotificationDelivery({
    plugin,
    onActivate: overrides.onActivate ?? ((target) => activated.push(target)),
    activateWindow:
      overrides.activateWindow ??
      (() => {
        raised.push(1);

        return Promise.resolve();
      }),
    playSound: overrides.playSound,
    log: overrides.log,
  });

  return { adapter, activated, raised };
}

describe("authorization", () => {
  test("nothing is asked until the first delivery that would occur", () => {
    const plugin = fakePlugin();
    delivery(plugin);

    expect(plugin.asked).toEqual([]);
    expect(plugin.sent).toEqual([]);
  });

  test("an already-granted permission is never requested again", async () => {
    const plugin = fakePlugin();
    const { adapter } = delivery(plugin);

    await adapter.deliver(input(NOTIFICATION));
    await adapter.deliver(input(NOTIFICATION));

    expect(plugin.asked).toEqual(["isPermissionGranted"]);
    expect(plugin.sent).toHaveLength(2);
  });

  test("denial is a supported state: nothing posts, nothing throws, and we never ask twice", async () => {
    const plugin = fakePlugin();
    plugin.alreadyGranted = false;
    plugin.response = "denied";
    const logger = recordingLogger();
    const { adapter } = delivery(plugin, { log: logger.log });

    await adapter.deliver(input(NOTIFICATION));
    await adapter.deliver(input(NOTIFICATION));

    expect(plugin.sent).toEqual([]);
    expect(plugin.asked).toEqual(["isPermissionGranted", "requestPermission"]);
    expect(logger.records).toContainEqual({
      level: "info",
      message: "notification authorization",
      fields: { granted: false },
    });
  });

  test("a plugin that throws is a denial, not a crash", async () => {
    const plugin = fakePlugin();
    plugin.isPermissionGranted = (): Promise<boolean> => Promise.reject(new TypeError("no plugin"));
    const logger = recordingLogger();
    const { adapter } = delivery(plugin, { log: logger.log });

    await adapter.deliver(input(NOTIFICATION));

    expect(plugin.sent).toEqual([]);
    expect(logger.records).toContainEqual({
      level: "warning",
      message: "notification authorization failed",
      fields: { error: "TypeError" },
    });
  });
});

describe("delivery", () => {
  test("the body reaches the plugin and nothing else", async () => {
    const plugin = fakePlugin();
    const logger = recordingLogger();
    const { adapter } = delivery(plugin, { log: logger.log });

    await adapter.deliver(input({ kind: "notification", title: SECRET_TITLE, body: SECRET_BODY }));
    await adapter.withdraw(SESSION);

    expect(plugin.sent[0]?.body).toContain(SECRET_BODY);
    expect(logger.text()).not.toContain(SECRET_BODY);
    expect(logger.text()).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(plugin.sent[0]?.extra)).not.toContain(SECRET_BODY);
  });

  test("a notification carries the ids a click needs to route", async () => {
    const plugin = fakePlugin();
    const { adapter } = delivery(plugin);

    await adapter.deliver(input(NOTIFICATION));

    expect(plugin.sent[0]?.extra).toEqual({ sessionID: SESSION, terminalID: TERMINAL });
    expect(plugin.sent[0]?.id).toBeNumber();
  });

  test("ids kept for withdrawal are bounded", async () => {
    const plugin = fakePlugin();
    const { adapter } = delivery(plugin);

    await Array.from({ length: MAXIMUM_OUTSTANDING_NOTIFICATIONS + 20 }).reduce<Promise<void>>(
      (previous) => previous.then(() => adapter.deliver(input(NOTIFICATION))),
      Promise.resolve(),
    );
    await adapter.withdraw(SESSION);

    expect(plugin.sent).toHaveLength(MAXIMUM_OUTSTANDING_NOTIFICATIONS + 20);
    expect(plugin.removed[0]).toHaveLength(MAXIMUM_OUTSTANDING_NOTIFICATIONS);
  });

  test("a burst arriving during the one authorization prompt is bounded", async () => {
    const plugin = fakePlugin();
    plugin.gate = gate();
    const { adapter } = delivery(plugin);

    const parked = Array.from({ length: MAXIMUM_IN_FLIGHT_DELIVERIES + 5 }, () =>
      adapter.deliver(input(NOTIFICATION)),
    );

    plugin.gate.open();
    await Promise.all(parked);

    expect(plugin.sent).toHaveLength(MAXIMUM_IN_FLIGHT_DELIVERIES);
  });

  test("the sound plays once per delivery, even when macOS has refused the banner", async () => {
    const plugin = fakePlugin();
    plugin.alreadyGranted = false;
    plugin.response = "denied";
    let plays = 0;
    const { adapter } = delivery(plugin, { playSound: () => void (plays += 1) });

    await adapter.deliver(input(NOTIFICATION));
    await adapter.deliver(input(NOTIFICATION));

    expect(plugin.sent).toEqual([]);
    expect(plays).toBe(2);
  });

  test("each event asks for its own sound", async () => {
    const plugin = fakePlugin();
    const events: AttentionEvent[] = [];
    const { adapter } = delivery(plugin, { playSound: (event) => void events.push(event) });

    await adapter.deliver(input({ kind: "bell" }));
    await adapter.deliver(
      input({ kind: "activity", activity: { kind: "waiting", need: "input" } }),
    );
    await adapter.deliver(
      input({ kind: "activity", activity: { kind: "finished", outcome: "completed" } }),
    );
    await adapter.deliver(
      input({ kind: "activity", activity: { kind: "finished", outcome: "failed" } }),
    );
    await adapter.deliver(input({ kind: "promptFinished", exitCode: 1, durationSeconds: 30 }));

    expect(events).toEqual(["bell", "waiting", "finished", "failed", "failed"]);
  });

  test("an agent that is only working asks for no sound at all", async () => {
    const plugin = fakePlugin();
    const events: AttentionEvent[] = [];
    const { adapter } = delivery(plugin, { playSound: (event) => void events.push(event) });

    await adapter.deliver(input({ kind: "activity", activity: { kind: "working" } }));

    expect(events).toEqual([]);
  });

  test("a delivery the overload cap drops is silent too", async () => {
    const plugin = fakePlugin();
    plugin.gate = gate();
    let plays = 0;
    const { adapter } = delivery(plugin, { playSound: () => void (plays += 1) });

    const parked = Array.from({ length: MAXIMUM_IN_FLIGHT_DELIVERIES + 5 }, () =>
      adapter.deliver(input(NOTIFICATION)),
    );

    plugin.gate.open();
    await Promise.all(parked);

    expect(plays).toBe(MAXIMUM_IN_FLIGHT_DELIVERIES);
  });
});

describe("withdrawal", () => {
  test("removes that session's notifications and leaves everyone else's", async () => {
    const plugin = fakePlugin();
    const { adapter } = delivery(plugin);

    await adapter.deliver(input(NOTIFICATION));
    await adapter.deliver(input(NOTIFICATION, OTHER));
    await adapter.deliver(input(NOTIFICATION));

    await adapter.withdraw(SESSION);

    const mine = plugin.sent
      .filter((sent) => sent.extra?.["sessionID"] === SESSION)
      .map((sent) => sent.id);

    expect(plugin.removed).toHaveLength(1);
    expect(plugin.removed[0]?.toSorted()).toEqual(mine.toSorted() as number[]);
  });

  test("a session removed mid-authorization never posts at all", async () => {
    const plugin = fakePlugin();
    plugin.gate = gate();
    const { adapter } = delivery(plugin);

    const parked = adapter.deliver(input(NOTIFICATION));
    await adapter.withdraw(SESSION);
    plugin.gate.open();
    await parked;

    expect(plugin.sent).toEqual([]);
  });

  test("a backend with no removal command is recorded once and not retried", async () => {
    const plugin = fakePlugin();
    plugin.removalFails = true;
    const logger = recordingLogger();
    const { adapter } = delivery(plugin, { log: logger.log });

    await adapter.deliver(input(NOTIFICATION));
    await adapter.withdraw(SESSION);
    await adapter.deliver(input(NOTIFICATION));
    await adapter.withdraw(SESSION);

    expect(plugin.sent).toHaveLength(2);
    expect(
      logger.records.filter((record) => record.message === "notification removal unsupported"),
    ).toHaveLength(1);
  });

  test("withdrawing a session with nothing on screen touches the plugin at all", async () => {
    const plugin = fakePlugin();
    const { adapter } = delivery(plugin);

    await adapter.withdraw(SESSION);

    expect(plugin.removed).toEqual([]);
  });
});

describe("clicking", () => {
  test("activates the app, routes to the session's terminal, and withdraws it", async () => {
    const plugin = fakePlugin();
    const { adapter, activated, raised } = delivery(plugin);

    await adapter.deliver(input(NOTIFICATION));
    const posted = plugin.sent[0];

    expect(posted).toBeDefined();

    if (posted === undefined) return;

    plugin.click(posted);
    await Promise.resolve();

    expect(activated).toEqual([{ sessionID: SESSION, terminalID: TERMINAL }]);
    expect(raised).toHaveLength(1);
    expect(plugin.removed).toEqual([[posted.id as number]]);
  });

  test("a notification we did not post routes nowhere, even half-addressed", async () => {
    const plugin = fakePlugin();
    const { adapter, activated } = delivery(plugin);

    await adapter.deliver(input(NOTIFICATION));
    plugin.click({ title: "someone else's", extra: { other: 1 } });
    plugin.click({ title: "half", extra: { sessionID: SESSION } });
    plugin.click({ title: "the other half", extra: { terminalID: TERMINAL } });

    expect(activated).toEqual([]);
  });

  test("a backend with no click listener is recorded once and delivery still works", async () => {
    const plugin = fakePlugin();
    plugin.listenerFails = true;
    const logger = recordingLogger();
    const { adapter } = delivery(plugin, { log: logger.log });

    await adapter.deliver(input(NOTIFICATION));
    await adapter.deliver(input(NOTIFICATION));
    await Promise.resolve();

    expect(plugin.sent).toHaveLength(2);
    expect(
      logger.records.filter(
        (record) => record.message === "notification click routing unavailable",
      ),
    ).toHaveLength(1);
  });

  test("a window that refuses to come forward still selects the session", async () => {
    const plugin = fakePlugin();
    const logger = recordingLogger();
    const activated: AttentionTarget[] = [];

    const { adapter } = delivery(plugin, {
      log: logger.log,
      onActivate: (target) => activated.push(target),
      activateWindow: () => Promise.reject(new RangeError("permission denied")),
    });

    await adapter.deliver(input(NOTIFICATION));
    const posted = plugin.sent[0];

    if (posted === undefined) throw new Error("nothing posted");

    plugin.click(posted);
    await Promise.resolve();
    await Promise.resolve();

    expect(activated).toEqual([{ sessionID: SESSION, terminalID: TERMINAL }]);
    expect(logger.records).toContainEqual({
      level: "debug",
      message: "window activation failed",
      fields: { error: "RangeError" },
    });
  });
});

describe("what the user reads", () => {
  test("both routing facts are in the title, and the body is the program's own", () => {
    expect(notificationContent(input({ kind: "notification", body: "build finished" }))).toEqual({
      title: "api server — claude",
      body: "build finished",
    });
    expect(
      notificationContent(input({ kind: "notification", title: "codex", body: "needs input" })),
    ).toEqual({ title: "api server — claude", body: "codex: needs input" });
  });

  test("a finished prompt gets a sentence about the event, never scrollback", () => {
    expect(
      notificationContent(input({ kind: "promptFinished", exitCode: 130, durationSeconds: 42.4 }))
        .body,
    ).toBe("A command failed with status 130 after 42s.");
    expect(notificationContent(input({ kind: "promptFinished", durationSeconds: 12 })).body).toBe(
      "A command finished after 12s.",
    );
  });

  test("a reported activity gets the agent's own words as a sentence, under the same title", () => {
    expect(
      notificationContent(
        input({ kind: "activity", activity: { kind: "waiting", need: "permission" } }),
      ),
    ).toEqual({ title: "api server — claude", body: "Waiting for permission." });
    expect(
      notificationContent(input({ kind: "activity", activity: { kind: "waiting", need: "input" } }))
        .body,
    ).toBe("Waiting for your answer.");
    expect(
      notificationContent(
        input({ kind: "activity", activity: { kind: "finished", outcome: "completed" } }),
      ).body,
    ).toBe("Finished.");
    expect(
      notificationContent(
        input({ kind: "activity", activity: { kind: "finished", outcome: "failed" } }),
      ).body,
    ).toBe("Stopped with an error.");
  });
});

describe("non-negotiable 11: bodies are never logged and never persisted", () => {
  test("no log record from any path carries the body or the title", async () => {
    const carrying: AttentionKind = {
      kind: "notification",
      title: SECRET_TITLE,
      body: SECRET_BODY,
    };

    const secretly = (
      session: SessionID = SESSION,
    ): Parameters<AttentionDelivering["deliver"]>[0] => ({
      ...input(carrying, session),
      sessionName: SECRET_SESSION_NAME,
      terminalTitle: SECRET_TERMINAL_TITLE,
    });

    const granted = fakePlugin();
    const grantedLog = recordingLogger();
    const { adapter } = delivery(granted, { log: grantedLog.log });

    await adapter.deliver(secretly());
    const posted = granted.sent[0];

    if (posted === undefined) throw new Error("nothing posted");

    granted.click(posted);
    await Promise.resolve();
    await adapter.deliver(secretly(OTHER));
    await adapter.withdraw(OTHER);

    const denied = fakePlugin();
    denied.alreadyGranted = false;
    denied.response = "denied";
    const deniedLog = recordingLogger();
    const refusing = delivery(denied, { log: deniedLog.log }).adapter;
    await refusing.deliver(secretly());

    const failing = fakePlugin();
    failing.removalFails = true;
    failing.listenerFails = true;
    const failingLog = recordingLogger();
    const degraded = delivery(failing, { log: failingLog.log }).adapter;
    await degraded.deliver(secretly());
    await degraded.withdraw(SESSION);
    await Promise.resolve();

    const records = [...grantedLog.records, ...deniedLog.records, ...failingLog.records];

    expect(records.length).toBeGreaterThan(5);

    for (const record of records) {
      const written = `${record.message} ${JSON.stringify(record.fields ?? {})}`;

      expect(written).not.toContain(SECRET_BODY);
      expect(written).not.toContain(SECRET_TITLE);
      expect(written).not.toContain(SECRET_SESSION_NAME);
      expect(written).not.toContain(SECRET_TERMINAL_TITLE);
    }

    expect(granted.sent[0]?.body).toContain(SECRET_BODY);
    expect(granted.sent[0]?.body).toContain(SECRET_TITLE);
    expect(granted.sent[0]?.title).toContain(SECRET_TERMINAL_TITLE);
  });
});
