import { describe, expect, test } from "bun:test";

import { now, type SessionID, type TerminalID } from "@janela/core";
import {
  encodeDaemonMessage,
  encodeFrame,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
} from "@janela/protocol";

import { CLIENT_NAME, liveEnvironment } from "./environment.ts";
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

  return { invoke, commands };
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

  test("attention delivery is a no-op until #36, and never rejects", async () => {
    const environment = liveEnvironment({ invoke: fakeShell().invoke });

    // A throwing adapter would turn a delivered signal into an unhandled
    // rejection inside the pump.
    const delivered = await environment.attention.deliver({
      signal: {
        kind: { kind: "bell" },
        terminalID: terminalID("t"),
        sessionID: sessionID("s"),
        id: "one",
        occurredAt: now(),
      },
      sessionName: "feature",
      terminalTitle: "zsh",
    });

    expect(delivered).toBeUndefined();
  });
});
