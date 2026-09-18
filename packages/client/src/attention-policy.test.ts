import { describe, expect, test } from "bun:test";

import type { AgentActivity, Instant, Session, SessionID, TerminalID } from "@janela/core";
import type { AttentionKind, AttentionSignal } from "@janela/protocol";

import {
  COALESCING_WINDOW_SECONDS,
  LONG_RUNNING_THRESHOLD_SECONDS,
  createAttentionPolicy,
  routeAttention,
  type AttentionContext,
  type AttentionDelivering,
  type AttentionPreferences,
  type AttentionRoutingOptions,
  type AttentionSource,
} from "./attention-policy.ts";
import { createStores } from "./stores.ts";
import {
  fakeSession,
  fakeTerminalDescriptor,
  recordingLogger,
  snapshot,
  terminalID,
} from "./test-fakes.ts";

interface Delivered {
  readonly sessionID: SessionID;
  readonly terminalID: TerminalID;
  readonly sessionName: string;
  readonly terminalTitle: string;
  readonly kind: AttentionKind;
}

interface RecordingDelivery extends AttentionDelivering {
  readonly delivered: readonly Delivered[];
  readonly withdrawn: readonly SessionID[];
  failNext(error: Error): void;
}

const SESSION = "s1" as SessionID;

const OTHER_SESSION = "s2" as SessionID;

const NOBODY_LOOKING: AttentionContext = { isApplicationActive: false };

const notification: AttentionKind = { kind: "notification", body: "done" };

const prompt = (exitCode: number | undefined, durationSeconds: number): AttentionKind =>
  exitCode === undefined
    ? { kind: "promptFinished", durationSeconds }
    : { kind: "promptFinished", exitCode, durationSeconds };

const DEFAULT_PREFERENCES: AttentionPreferences = {
  notifiesOnBell: false,
  notifiesWhenAgentFinishes: true,
  notifiesWhenAgentWaits: true,
};

const preferences = (overrides: Partial<AttentionPreferences>): AttentionPreferences => ({
  ...DEFAULT_PREFERENCES,
  ...overrides,
});

const activity = (reported: AgentActivity): AttentionKind => ({
  kind: "activity",
  activity: reported,
});

function at(seconds: number): Instant {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z` as Instant;
}

function signal(
  kind: AttentionKind,
  options: {
    readonly terminal?: TerminalID;
    readonly session?: SessionID;
    readonly seconds?: number;
    readonly occurredAt?: string;
  } = {},
): AttentionSignal {
  counter += 1;

  return {
    kind,
    terminalID: options.terminal ?? terminalID(),
    sessionID: options.session ?? SESSION,
    id: `signal-${counter}`,
    occurredAt: (options.occurredAt as Instant | undefined) ?? at(options.seconds ?? 0),
  };
}

function named(
  id: string,
  name: string,
  terminals: readonly (readonly [TerminalID, string])[],
): Session {
  return {
    ...fakeSession(id),
    name,
    terminals: terminals.map(([terminal, title]) => ({
      ...fakeTerminalDescriptor(terminal),
      title,
    })),
  };
}

function recordingDelivery(): RecordingDelivery {
  const delivered: Delivered[] = [];
  const withdrawn: SessionID[] = [];
  let failure: Error | undefined;

  return {
    delivered,
    withdrawn,
    failNext(error: Error): void {
      failure = error;
    },
    deliver(input): Promise<void> {
      if (failure !== undefined) {
        const thrown = failure;
        failure = undefined;

        return Promise.reject(thrown);
      }

      delivered.push({
        sessionID: input.signal.sessionID,
        terminalID: input.signal.terminalID,
        sessionName: input.sessionName,
        terminalTitle: input.terminalTitle,
        kind: input.signal.kind,
      });

      return Promise.resolve();
    },
    withdraw(id: SessionID): Promise<void> {
      withdrawn.push(id);

      return Promise.resolve();
    },
  };
}

function emitter(): AttentionSource & { emit(emitted: AttentionSignal): void } {
  const handlers = new Set<(emitted: AttentionSignal) => void>();

  return {
    onAttention(handler): () => void {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },
    emit(emitted: AttentionSignal): void {
      for (const handler of handlers) handler(emitted);
    },
  };
}

function routed(
  overrides: Partial<
    Pick<AttentionRoutingOptions, "isApplicationActive" | "focusedTerminalID" | "preferences">
  > = {},
) {
  const stores = createStores();
  const source = emitter();
  const delivery = recordingDelivery();
  const logger = recordingLogger();

  const routing = routeAttention({
    source,
    sessions: stores.sessions,
    policy: createAttentionPolicy(),
    delivery,
    isApplicationActive: overrides.isApplicationActive ?? ((): boolean => false),
    focusedTerminalID: overrides.focusedTerminalID ?? ((): TerminalID | undefined => undefined),
    preferences: overrides.preferences ?? ((): AttentionPreferences => DEFAULT_PREFERENCES),
    log: logger.log,
  });

  return { ...stores, source, delivery, logger, routing };
}

let counter = 0;

describe("what is worth interrupting for", () => {
  test("a bare bell is not, while the bell preference is off", () => {
    const policy = createAttentionPolicy();

    expect(
      policy.shouldDeliver(signal({ kind: "bell" }), NOBODY_LOOKING, DEFAULT_PREFERENCES),
    ).toBe(false);
  });

  test("a bare bell is, once the bell preference is on", () => {
    const policy = createAttentionPolicy();

    expect(
      policy.shouldDeliver(
        signal({ kind: "bell" }),
        NOBODY_LOOKING,
        preferences({ notifiesOnBell: true }),
      ),
    ).toBe(true);
  });

  test("a notification is, because the program asked for one by name", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal(notification), NOBODY_LOOKING, DEFAULT_PREFERENCES)).toBe(
      true,
    );
  });

  test("a finished prompt is, only when it failed and ran long enough", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal(prompt(1, 2)), NOBODY_LOOKING, DEFAULT_PREFERENCES)).toBe(
      false,
    );
    expect(policy.shouldDeliver(signal(prompt(1, 15)), NOBODY_LOOKING, DEFAULT_PREFERENCES)).toBe(
      true,
    );
    expect(policy.shouldDeliver(signal(prompt(0, 15)), NOBODY_LOOKING, DEFAULT_PREFERENCES)).toBe(
      false,
    );
    expect(
      policy.shouldDeliver(signal(prompt(undefined, 15)), NOBODY_LOOKING, DEFAULT_PREFERENCES),
    ).toBe(false);
    expect(
      policy.shouldDeliver(
        signal(prompt(1, LONG_RUNNING_THRESHOLD_SECONDS)),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
  });

  test("an agent that is working never is, whatever the preferences say", () => {
    const policy = createAttentionPolicy();

    expect(
      policy.shouldDeliver(
        signal(activity({ kind: "working" })),
        NOBODY_LOOKING,
        preferences({ notifiesWhenAgentFinishes: true, notifiesWhenAgentWaits: true }),
      ),
    ).toBe(false);
  });

  test("an agent waiting on the user is, unless the waiting preference is off", () => {
    for (const need of ["permission", "input"] as const) {
      expect(
        createAttentionPolicy().shouldDeliver(
          signal(activity({ kind: "waiting", need })),
          NOBODY_LOOKING,
          preferences({ notifiesWhenAgentWaits: true }),
        ),
      ).toBe(true);
      expect(
        createAttentionPolicy().shouldDeliver(
          signal(activity({ kind: "waiting", need })),
          NOBODY_LOOKING,
          preferences({ notifiesWhenAgentWaits: false }),
        ),
      ).toBe(false);
    }
  });

  test("an agent that finished is, either outcome, unless the finished preference is off", () => {
    for (const outcome of ["completed", "failed"] as const) {
      expect(
        createAttentionPolicy().shouldDeliver(
          signal(activity({ kind: "finished", outcome })),
          NOBODY_LOOKING,
          preferences({ notifiesWhenAgentFinishes: true }),
        ),
      ).toBe(true);
      expect(
        createAttentionPolicy().shouldDeliver(
          signal(activity({ kind: "finished", outcome })),
          NOBODY_LOOKING,
          preferences({ notifiesWhenAgentFinishes: false }),
        ),
      ).toBe(false);
    }
  });

  test("the waiting and finished preferences gate each other's signals, not their own", () => {
    expect(
      createAttentionPolicy().shouldDeliver(
        signal(activity({ kind: "waiting", need: "permission" })),
        NOBODY_LOOKING,
        preferences({ notifiesWhenAgentFinishes: false, notifiesWhenAgentWaits: true }),
      ),
    ).toBe(true);
    expect(
      createAttentionPolicy().shouldDeliver(
        signal(activity({ kind: "finished", outcome: "completed" })),
        NOBODY_LOOKING,
        preferences({ notifiesWhenAgentFinishes: true, notifiesWhenAgentWaits: false }),
      ),
    ).toBe(true);
  });
});

describe("the user is looking straight at it", () => {
  const terminal = terminalID();

  const looking: AttentionContext = {
    isApplicationActive: true,
    selectedSessionID: SESSION,
    focusedTerminalID: terminal,
  };

  test("all three together suppress the notification", () => {
    const policy = createAttentionPolicy();

    expect(
      policy.shouldDeliver(signal(notification, { terminal }), looking, DEFAULT_PREFERENCES),
    ).toBe(false);
  });

  test("any one of the three flipped delivers it", () => {
    for (const context of [
      { ...looking, isApplicationActive: false },
      { ...looking, selectedSessionID: OTHER_SESSION },
      { ...looking, focusedTerminalID: terminalID() },
    ] satisfies AttentionContext[]) {
      const policy = createAttentionPolicy();

      expect(
        policy.shouldDeliver(signal(notification, { terminal }), context, DEFAULT_PREFERENCES),
      ).toBe(true);
    }
  });

  test("a suppressed signal is not recorded, so the next one still gets through", () => {
    const policy = createAttentionPolicy();

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, seconds: 0 }),
        looking,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(false);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, seconds: 1 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
  });
});

describe("coalescing", () => {
  test("four notifications inside the window are one, and the next one after it is news", () => {
    const policy = createAttentionPolicy();
    const terminal = terminalID();

    const delivered = [0, 1, 2, 4].map((seconds) =>
      policy.shouldDeliver(
        signal(notification, { terminal, seconds }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    );

    expect(delivered).toEqual([true, false, false, false]);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, seconds: COALESCING_WINDOW_SECONDS }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
  });

  test("coalescing is per terminal, not per session", () => {
    const policy = createAttentionPolicy();
    const [first, second] = [terminalID(), terminalID()];

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: first, seconds: 0 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: second, seconds: 1 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
  });

  test("an unparseable stamp never sticks in the table", () => {
    const policy = createAttentionPolicy();
    const terminal = terminalID();

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, occurredAt: "not-a-date" }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, seconds: 1 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
  });
});

describe("forgetSession", () => {
  test("drops that session's entries and leaves everyone else coalesced", () => {
    const policy = createAttentionPolicy();
    const [mine, theirs] = [terminalID(), terminalID()];

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: mine, session: SESSION, seconds: 0 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: theirs, session: OTHER_SESSION, seconds: 0 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);

    policy.forgetSession(SESSION);

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: mine, session: SESSION, seconds: 1 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: theirs, session: OTHER_SESSION, seconds: 1 }),
        NOBODY_LOOKING,
        DEFAULT_PREFERENCES,
      ),
    ).toBe(false);
  });
});

describe("routing a signal to delivery", () => {
  test("an unwatched terminal's notification reaches delivery, named", () => {
    const terminal = terminalID();
    const { mirror, source, delivery } = routed();
    mirror.apply(snapshot([named("s1", "api server", [[terminal, "claude"]])]));

    source.emit(signal(notification, { terminal, session: "s1" as SessionID }));

    expect(delivery.delivered).toEqual([
      {
        sessionID: "s1" as SessionID,
        terminalID: terminal,
        sessionName: "api server",
        terminalTitle: "claude",
        kind: notification,
      },
    ]);
  });

  test("the preferences are read per signal, so a flipped switch takes effect at once", () => {
    const [first, second] = [terminalID(), terminalID()];
    let notifiesOnBell = false;

    const { mirror, source, delivery } = routed({
      preferences: () => preferences({ notifiesOnBell }),
    });

    mirror.apply(
      snapshot([
        named("s1", "api server", [
          [first, "claude"],
          [second, "codex"],
        ]),
      ]),
    );

    source.emit(signal({ kind: "bell" }, { terminal: first, session: "s1" as SessionID }));

    expect(delivery.delivered).toEqual([]);

    notifiesOnBell = true;
    source.emit(signal({ kind: "bell" }, { terminal: second, session: "s1" as SessionID }));

    expect(delivery.delivered.map((entry) => entry.terminalID)).toEqual([second]);
  });

  test("the terminal the user is staring at is not interrupted, and its badge is not touched", () => {
    const terminal = terminalID();

    const { mirror, sessions, source, delivery } = routed({
      isApplicationActive: () => true,
      focusedTerminalID: () => terminal,
    });

    mirror.apply(
      snapshot([named("s1", "api server", [[terminal, "claude"]])], [], {
        [terminal]: { kind: "needsAttention" },
      }),
    );
    sessions.selection = "s1" as SessionID;

    source.emit(signal(notification, { terminal, session: "s1" as SessionID }));

    expect(delivery.delivered).toEqual([]);
    expect(sessions.terminalStates[terminal]).toEqual({ kind: "needsAttention" });
    expect(sessions.isRunning("s1" as SessionID)).toBe(true);
  });

  test("a signal for a session this mirror does not hold delivers nothing", () => {
    const terminal = terminalID();
    const { mirror, source, delivery } = routed();
    mirror.apply(snapshot([named("s1", "api server", [[terminal, "claude"]])]));

    source.emit(signal(notification, { terminal: terminalID(), session: "ghost" as SessionID }));
    source.emit(signal(notification, { terminal: terminalID(), session: "s1" as SessionID }));

    expect(delivery.delivered).toEqual([]);
  });

  test("a rejecting deliverer costs one log line and not the next signal", async () => {
    const first = terminalID();
    const second = terminalID();
    const { mirror, source, delivery, logger } = routed();
    mirror.apply(
      snapshot([
        named("s1", "api server", [
          [first, "claude"],
          [second, "dev"],
        ]),
      ]),
    );

    delivery.failNext(new RangeError("notification centre said no"));
    source.emit(signal(notification, { terminal: first, session: "s1" as SessionID }));
    source.emit(signal(notification, { terminal: second, session: "s1" as SessionID }));
    await Promise.resolve();

    expect(delivery.delivered.map((entry) => entry.terminalID)).toEqual([second]);
    expect(logger.with("attention delivery failed")).toEqual([
      { level: "warning", message: "attention delivery failed", fields: { error: "RangeError" } },
    ]);
  });
});

describe("routing a removal to withdrawal", () => {
  test("a session leaving the mirror is withdrawn and forgotten", () => {
    const mine = terminalID();
    const theirs = terminalID();
    const { mirror, source, delivery } = routed();

    const both = [
      named("s1", "api server", [[mine, "claude"]]),
      named("s2", "web", [[theirs, "vite"]]),
    ];

    mirror.apply(snapshot(both));

    source.emit(signal(notification, { terminal: mine, session: "s1" as SessionID, seconds: 0 }));
    mirror.apply(snapshot([named("s2", "web", [[theirs, "vite"]])]));

    expect(delivery.withdrawn).toEqual(["s1" as SessionID]);

    mirror.apply(snapshot(both));
    source.emit(signal(notification, { terminal: mine, session: "s1" as SessionID, seconds: 1 }));

    expect(delivery.delivered).toHaveLength(2);
  });

  test("a session that merely changed is not withdrawn", () => {
    const terminal = terminalID();
    const { mirror, sessions, delivery } = routed();
    mirror.apply(snapshot([named("s1", "api server", [[terminal, "claude"]])]));

    mirror.apply(snapshot([named("s1", "renamed", [[terminal, "claude"]])]));
    sessions.selection = "s1" as SessionID;

    expect(delivery.withdrawn).toEqual([]);
  });
});

describe("the body", () => {
  test("reaches the deliverer and nothing else", async () => {
    const terminal = terminalID();

    const secret: AttentionKind = {
      kind: "notification",
      title: "TITLE-b9d1f2",
      body: "BODY-4c7e01",
    };

    const { mirror, sessions, source, delivery, logger } = routed();
    mirror.apply(snapshot([named("s1", "api server", [[terminal, "claude"]])]));

    source.emit(signal(secret, { terminal, session: "s1" as SessionID }));
    source.emit(signal(secret, { terminal: terminalID(), session: "s1" as SessionID }));
    delivery.failNext(new Error("down"));
    source.emit(signal(secret, { terminal, session: "s1" as SessionID, seconds: 30 }));
    await Promise.resolve();

    expect(delivery.delivered.map((entry) => entry.kind)).toEqual([secret]);
    expect(logger.text()).not.toContain("BODY-4c7e01");
    expect(logger.text()).not.toContain("TITLE-b9d1f2");
    expect(JSON.stringify(sessions.sessions)).not.toContain("BODY-4c7e01");
  });
});

describe("stop", () => {
  test("ends both subscriptions", () => {
    const terminal = terminalID();
    const { mirror, source, delivery, routing } = routed();
    mirror.apply(snapshot([named("s1", "api server", [[terminal, "claude"]])]));

    routing.stop();
    source.emit(signal(notification, { terminal, session: "s1" as SessionID }));
    mirror.apply(snapshot([]));

    expect(delivery.delivered).toEqual([]);
    expect(delivery.withdrawn).toEqual([]);
  });
});
