import { describe, expect, test } from "bun:test";

import type { Instant, SessionID, TerminalID } from "@janela/core";
import type { AttentionKind, AttentionSignal } from "@janela/protocol";

import {
  COALESCING_WINDOW_SECONDS,
  LONG_RUNNING_THRESHOLD_SECONDS,
  createAttentionPolicy,
  type AttentionContext,
} from "./attention-policy.ts";
import { terminalID } from "./test-fakes.ts";

const SESSION = "s1" as SessionID;
const OTHER_SESSION = "s2" as SessionID;

/** Daemon time, as the daemon stamps it: the policy measures against this. */
function at(seconds: number): Instant {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z` as Instant;
}

let counter = 0;

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

const NOBODY_LOOKING: AttentionContext = { isApplicationActive: false };
const notification: AttentionKind = { kind: "notification", body: "done" };

/** `exactOptionalPropertyTypes`: an absent exit code is not an undefined one. */
const prompt = (exitCode: number | undefined, durationSeconds: number): AttentionKind =>
  exitCode === undefined
    ? { kind: "promptFinished", durationSeconds }
    : { kind: "promptFinished", exitCode, durationSeconds };

describe("what is worth interrupting for", () => {
  test("a bare bell never is, even when nobody is looking", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal({ kind: "bell" }), NOBODY_LOOKING)).toBe(false);
  });

  test("a notification is, because the program asked for one by name", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal(notification), NOBODY_LOOKING)).toBe(true);
  });

  test("a finished prompt is, only when it failed and ran long enough", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal(prompt(1, 2)), NOBODY_LOOKING)).toBe(false);
    expect(policy.shouldDeliver(signal(prompt(1, 15)), NOBODY_LOOKING)).toBe(true);
    expect(policy.shouldDeliver(signal(prompt(0, 15)), NOBODY_LOOKING)).toBe(false);
    expect(policy.shouldDeliver(signal(prompt(undefined, 15)), NOBODY_LOOKING)).toBe(false);
    // The boundary is inclusive: exactly the threshold is long-running.
    expect(
      policy.shouldDeliver(signal(prompt(1, LONG_RUNNING_THRESHOLD_SECONDS)), NOBODY_LOOKING),
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

    expect(policy.shouldDeliver(signal(notification, { terminal }), looking)).toBe(false);
  });

  test("any one of the three flipped delivers it", () => {
    for (const context of [
      { ...looking, isApplicationActive: false },
      { ...looking, selectedSessionID: OTHER_SESSION },
      { ...looking, focusedTerminalID: terminalID() },
    ] satisfies AttentionContext[]) {
      const policy = createAttentionPolicy();
      expect(policy.shouldDeliver(signal(notification, { terminal }), context)).toBe(true);
    }
  });

  test("a suppressed signal is not recorded, so the next one still gets through", () => {
    const policy = createAttentionPolicy();

    expect(policy.shouldDeliver(signal(notification, { terminal, seconds: 0 }), looking)).toBe(
      false,
    );
    expect(
      policy.shouldDeliver(signal(notification, { terminal, seconds: 1 }), NOBODY_LOOKING),
    ).toBe(true);
  });
});

describe("coalescing", () => {
  test("four notifications inside the window are one, and the next one after it is news", () => {
    const policy = createAttentionPolicy();
    const terminal = terminalID();
    const delivered = [0, 1, 2, 4].map((seconds) =>
      policy.shouldDeliver(signal(notification, { terminal, seconds }), NOBODY_LOOKING),
    );

    expect(delivered).toEqual([true, false, false, false]);

    // The window is measured from the delivery, and `>=` expires it.
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, seconds: COALESCING_WINDOW_SECONDS }),
        NOBODY_LOOKING,
      ),
    ).toBe(true);
  });

  test("coalescing is per terminal, not per session", () => {
    const policy = createAttentionPolicy();
    const [first, second] = [terminalID(), terminalID()];

    expect(
      policy.shouldDeliver(signal(notification, { terminal: first, seconds: 0 }), NOBODY_LOOKING),
    ).toBe(true);
    expect(
      policy.shouldDeliver(signal(notification, { terminal: second, seconds: 1 }), NOBODY_LOOKING),
    ).toBe(true);
  });

  test("an unparseable stamp never sticks in the table", () => {
    const policy = createAttentionPolicy();
    const terminal = terminalID();

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal, occurredAt: "not-a-date" }),
        NOBODY_LOOKING,
      ),
    ).toBe(true);
    // A `NaN` elapsed is false for every comparison, so an entry stamped with one
    // would coalesce everything for that terminal forever.
    expect(
      policy.shouldDeliver(signal(notification, { terminal, seconds: 1 }), NOBODY_LOOKING),
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
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: theirs, session: OTHER_SESSION, seconds: 0 }),
        NOBODY_LOOKING,
      ),
    ).toBe(true);

    policy.forgetSession(SESSION);

    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: mine, session: SESSION, seconds: 1 }),
        NOBODY_LOOKING,
      ),
    ).toBe(true);
    expect(
      policy.shouldDeliver(
        signal(notification, { terminal: theirs, session: OTHER_SESSION, seconds: 1 }),
        NOBODY_LOOKING,
      ),
    ).toBe(false);
  });
});
