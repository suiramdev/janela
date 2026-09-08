import { describe, expect, test } from "bun:test";

import type { SessionID } from "@janela/core";
import { nullLogSink, setLogSink, log } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";

import {
  createIdleMonitor,
  IDLE_GRACE_PERIOD_MS,
  IDLE_POLL_INTERVAL_MS,
  isDaemonIdle,
  shutdown,
} from "./lifecycle.ts";

setLogSink(nullLogSink);
const silent = log("session");

/** A clock a test moves by hand, so the grace period is exact. */
interface FakeClock {
  now(): number;
  advance(milliseconds: number): void;
}

function fakeClock(): FakeClock {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (milliseconds) => {
      value += milliseconds;
    },
  };
}

/**
 * A registry that records the calls that matter and nothing else.
 *
 * Faked rather than real because the behaviour under test is the *order* of two
 * calls, and a real registry would need real PTYs to have a `liveCount` at all.
 */
interface FakeRegistry {
  readonly registry: TerminalRegistry;
  readonly calls: string[];
  liveCount: number;
}

function fakeRegistry(liveCount = 0): FakeRegistry {
  const calls: string[] = [];
  const state = { liveCount };
  return {
    calls,
    get liveCount(): number {
      return state.liveCount;
    },
    set liveCount(value: number) {
      state.liveCount = value;
    },
    registry: {
      get: (): LiveTerminal | undefined => undefined,
      register: (): void => {},
      remove: (): void => {},
      inSession: (_id: SessionID): readonly LiveTerminal[] => [],
      get liveCount(): number {
        return state.liveCount;
      },
      hangUpAll: async (): Promise<void> => {
        calls.push("hangUpAll");
        // A real hang-up awaits the reader threads winding down, so the order
        // under test has to survive an await point.
        await Promise.resolve();
        state.liveCount = 0;
      },
    },
  };
}

describe("the idle monitor", () => {
  test("ADR 0017's grace period is five minutes", () => {
    expect(IDLE_GRACE_PERIOD_MS).toBe(5 * 60_000);
    expect(IDLE_POLL_INTERVAL_MS).toBeLessThan(IDLE_GRACE_PERIOD_MS);
  });

  test("does not exit while a client is connected or a terminal is live", () => {
    const clock = fakeClock();
    let expired = 0;
    const monitor = createIdleMonitor({
      isIdle: () => false,
      onIdleExpired: () => (expired += 1),
      now: clock.now,
    });

    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS * 10);
    monitor.poll();

    expect(expired).toBe(0);
  });

  test("does not exit before the grace period has elapsed", () => {
    const clock = fakeClock();
    let expired = 0;
    const monitor = createIdleMonitor({
      isIdle: () => true,
      onIdleExpired: () => (expired += 1),
      now: clock.now,
    });

    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS - 1);
    monitor.poll();

    expect(expired).toBe(0);
  });

  test("exits once the grace period has elapsed", () => {
    const clock = fakeClock();
    let expired = 0;
    const monitor = createIdleMonitor({
      isIdle: () => true,
      onIdleExpired: () => (expired += 1),
      now: clock.now,
    });

    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS);
    monitor.poll();

    expect(expired).toBe(1);
  });

  test("a reconnect during the grace period restarts the clock", () => {
    const clock = fakeClock();
    let idle = true;
    let expired = 0;
    const monitor = createIdleMonitor({
      isIdle: () => idle,
      onIdleExpired: () => (expired += 1),
      now: clock.now,
    });

    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS - 1_000);
    // A client comes back: the daemon it reconnected to must still be there in
    // another five minutes, not one second.
    idle = false;
    monitor.poll();
    idle = true;
    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS - 1);
    monitor.poll();

    expect(expired).toBe(0);

    clock.advance(1);
    monitor.poll();
    expect(expired).toBe(1);
  });

  test("expires once, however many polls follow", () => {
    const clock = fakeClock();
    let expired = 0;
    const monitor = createIdleMonitor({
      isIdle: () => true,
      onIdleExpired: () => (expired += 1),
      now: clock.now,
    });

    monitor.poll();
    clock.advance(IDLE_GRACE_PERIOD_MS);
    monitor.poll();
    monitor.poll();
    monitor.poll();

    expect(expired).toBe(1);
  });
});

describe("isDaemonIdle", () => {
  test("no clients and no live terminals is idle", () => {
    expect(isDaemonIdle({ connectionCount: 0, canExitWhenIdle: () => true })).toBe(true);
  });

  test("a live terminal blocks idle exit even with no clients connected", () => {
    // The asymmetry is the entire feature: the daemon exists to outlive clients,
    // not to serve them. Without this conjunct it would exit five minutes after
    // the user closed the window on a running build.
    expect(isDaemonIdle({ connectionCount: 0, canExitWhenIdle: () => false })).toBe(false);
  });

  test("a connected client blocks idle exit even with no live terminals", () => {
    expect(isDaemonIdle({ connectionCount: 1, canExitWhenIdle: () => true })).toBe(false);
  });
});

describe("shutdown", () => {
  test("hangs up every terminal before the process ends", async () => {
    const fake = fakeRegistry(3);

    await shutdown({
      terminals: fake.registry,
      log: silent,
      // One array, deliberately: two arrays concatenated afterwards would record
      // the calls and assert nothing about their order.
      stopServing: () => fake.calls.push("stopServing"),
      finish: (code) => fake.calls.push(`finish:${code}`),
    });

    // Children must get SIGHUP from a parent that still exists; the alternative
    // is every shell reparented onto launchd, running and invisible.
    expect(fake.calls).toEqual(["hangUpAll", "stopServing", "finish:0"]);
  });

  test("exits 0, so KeepAlive's SuccessfulExit=false leaves the daemon down", async () => {
    const fake = fakeRegistry();
    let code: number | undefined;

    await shutdown({
      terminals: fake.registry,
      log: silent,
      stopServing: () => {},
      finish: (value) => (code = value),
    });

    expect(code).toBe(0);
  });
});
