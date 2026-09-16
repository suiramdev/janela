import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import type { Instant, SessionID, TerminalDescriptor, TerminalID } from "@janela/core";

import { createLiveTerminal, type LiveTerminal } from "./live-terminal.ts";
import { createTerminalRegistry } from "./registry.ts";

const DEADLINE_MS = 15_000;
const POLL_MS = 4;
const ENVIRONMENT = { TERM: "xterm-256color", PATH: "/usr/bin:/bin" };

const started: LiveTerminal[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0, started.length).map((terminal) => terminal.stop()));
});

function descriptor(id: string): TerminalDescriptor {
  return {
    id: id as TerminalID,
    title: "Shell",
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: "2025-01-01T00:00:00.000Z" as Instant,
  };
}

function live(id: string, session: string, script = "exec cat"): LiveTerminal {
  const terminal = createLiveTerminal({
    descriptor: descriptor(id),
    sessionID: session as SessionID,
    launch: {
      executable: "/bin/sh",
      arguments: ["sh", "-c", script],
      workingDirectory: tmpdir(),
      environment: ENVIRONMENT,
      initialSize: { columns: 80, rows: 24 },
    },
  });

  started.push(terminal);

  return terminal;
}

function drainUntil(terminals: readonly LiveTerminal[], done: () => boolean): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    for (const terminal of terminals) {
      terminal.drain();
    }

    if (done()) {
      clearInterval(timer);
      resolve();

      return;
    }

    if (Date.now() - startedAt > DEADLINE_MS) {
      clearInterval(timer);
      reject(new Error("timed out waiting for every terminal to exit"));
    }
  }, POLL_MS);

  return promise;
}

describe("membership", () => {
  test("registers, finds and removes by id, and removing twice is harmless", () => {
    const registry = createTerminalRegistry();
    const terminal = live("r-1", "s-1");

    expect(registry.get(terminal.id)).toBeUndefined();

    registry.register(terminal);

    expect(registry.get(terminal.id)).toBe(terminal);

    registry.remove(terminal.id);

    expect(registry.get(terminal.id)).toBeUndefined();
    expect(() => registry.remove(terminal.id)).not.toThrow();
  });

  test("registering the same id twice is a programming error, never a silent replacement", () => {
    const registry = createTerminalRegistry();
    registry.register(live("r-dup", "s-1"));

    expect(() => registry.register(live("r-dup", "s-1"))).toThrow();
  });

  test("lists a session's terminals across tabs and splits", () => {
    const registry = createTerminalRegistry();
    const first = live("r-a", "s-1");
    const second = live("r-b", "s-1");
    registry.register(first);
    registry.register(second);
    registry.register(live("r-c", "s-2"));

    expect(registry.inSession("s-1" as SessionID)).toEqual([first, second]);
    expect(registry.inSession("s-3" as SessionID)).toEqual([]);
  });
});

describe("liveCount", () => {
  test("counts only terminals holding a process, and a terminal asking for attention holds one", async () => {
    const registry = createTerminalRegistry();
    const idle = live("r-idle", "s-1");
    const running = live("r-running", "s-1");
    const belling = live("r-bell", "s-1", "stty raw -echo; printf '\\a'; exec cat");
    registry.register(idle);
    registry.register(running);
    registry.register(belling);

    expect(registry.liveCount).toBe(0);

    await running.start();
    await belling.start();
    await drainUntil([belling], () => belling.state.kind === "needsAttention");

    expect(registry.liveCount).toBe(2);

    await running.stop();
    await drainUntil([running], () => running.state.kind === "exited");

    expect(registry.liveCount).toBe(1);
  });
});

describe("hangUpAll", () => {
  test("hangs up every terminal, running or not", async () => {
    const registry = createTerminalRegistry();
    const idle = live("r-h-idle", "s-1");
    const first = live("r-h-1", "s-1");
    const second = live("r-h-2", "s-2");
    registry.register(idle);
    registry.register(first);
    registry.register(second);
    await first.start();
    await second.start();

    await registry.hangUpAll();
    await drainUntil(
      [first, second],
      () => first.state.kind === "exited" && second.state.kind === "exited",
    );

    expect(registry.liveCount).toBe(0);
    expect(idle.state).toEqual({ kind: "idle" });
  });
});
