import { describe, expect, test } from "bun:test";

import type { CommandID } from "@janela/ui";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

import {
  COMMAND_EVENT,
  installNativeMenu,
  tauriCommandSource,
  type CommandEventListener,
} from "./menu.ts";

interface FakeEvents {
  readonly listen: CommandEventListener;
  readonly events: readonly string[];
  readonly released: number;
  emit(payload: string): void;
  register(): Promise<void>;
  refuse(): Promise<void>;
}

function fakeEvents(): FakeEvents {
  const events: string[] = [];
  const handlers: EventCallback<string>[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<UnlistenFn>();
  let released = 0;
  let id = 0;

  return {
    events,
    get released(): number {
      return released;
    },
    listen: (event, handler) => {
      events.push(event);
      handlers.push(handler);

      return promise;
    },
    emit(payload: string): void {
      id += 1;

      for (const handler of handlers) handler({ event: COMMAND_EVENT, id, payload });
    },
    async register(): Promise<void> {
      resolve(() => {
        released += 1;
      });
      await promise;
    },
    async refuse(): Promise<void> {
      reject(new Error("no event plugin"));
      await promise.catch(() => undefined);
    },
  };
}

describe("tauriCommandSource", () => {
  test("delivers the menu's command ids and drops anything it does not know", async () => {
    const events = fakeEvents();
    const received: CommandID[] = [];

    tauriCommandSource({ listen: events.listen }).subscribe((id) => {
      received.push(id);
    });
    await events.register();

    events.emit("newSession");
    events.emit("not-a-command");
    events.emit("openSettings");

    expect(events.events).toEqual([COMMAND_EVENT]);
    expect(received).toEqual(["newSession", "openSettings"]);
  });

  test("unsubscribing releases the native listener", async () => {
    const events = fakeEvents();
    const unsubscribe = tauriCommandSource({ listen: events.listen }).subscribe(() => {});

    await events.register();
    unsubscribe();

    expect(events.released).toBe(1);
  });

  test("unsubscribing before the listener is registered still releases it", async () => {
    const events = fakeEvents();
    const unsubscribe = tauriCommandSource({ listen: events.listen }).subscribe(() => {});

    unsubscribe();

    expect(events.released).toBe(0);

    await events.register();

    expect(events.released).toBe(1);
  });

  test("a shell without the event plugin leaves the menu silent, not broken", async () => {
    const events = fakeEvents();
    const received: CommandID[] = [];

    const unsubscribe = tauriCommandSource({ listen: events.listen }).subscribe((id) => {
      received.push(id);
    });
    await events.refuse();

    expect(() => unsubscribe()).not.toThrow();
    expect(received).toEqual([]);
    expect(events.released).toBe(0);
  });
});

describe("installNativeMenu", () => {
  test("a shell that cannot build the menu is a warning, never a thrown error", async () => {
    const commands: string[] = [];

    await expect(
      installNativeMenu(async (command) => {
        commands.push(command);
        throw new Error("menu unavailable");
      }),
    ).resolves.toBeUndefined();
    expect(commands).toEqual(["install_menu"]);
  });
});
