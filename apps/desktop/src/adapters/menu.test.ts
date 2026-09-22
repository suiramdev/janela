import { describe, expect, test } from "bun:test";

import { DEFAULT_GLOBAL_SETTINGS, type CommandID, type GlobalSettings } from "@janela/ui";
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";

import {
  COMMAND_EVENT,
  installNativeMenu,
  syncNativeShortcuts,
  tauriCommandSource,
  type CommandEventListener,
  type MenuAccelerator,
  type ShortcutSettingsSource,
} from "./menu.ts";

interface FakeSettingsView extends ShortcutSettingsSource {
  set(settings: GlobalSettings): void;
  record(isRecording: boolean): void;
}

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

function fakeSettingsView(): FakeSettingsView {
  let settings = DEFAULT_GLOBAL_SETTINGS;
  let isRecording = false;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get settings(): GlobalSettings {
      return settings;
    },
    get isRecordingShortcut(): boolean {
      return isRecording;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      settings = next;
      notify();
    },
    record(next) {
      isRecording = next;
      notify();
    },
  };
}

describe("syncNativeShortcuts", () => {
  test("says nothing while every shortcut is the default, then sends the whole table on a change", () => {
    const sent: (readonly MenuAccelerator[])[] = [];
    const view = fakeSettingsView();

    syncNativeShortcuts((accelerators) => {
      sent.push(accelerators);

      return Promise.resolve();
    }, view);

    view.set({ ...DEFAULT_GLOBAL_SETTINGS, terminalFontSize: 16 });

    expect(sent).toEqual([]);

    view.set({ ...DEFAULT_GLOBAL_SETTINGS, commandShortcuts: { splitRight: "CmdOrCtrl+E" } });

    const [accelerators] = sent;

    expect(sent).toHaveLength(1);
    expect(accelerators?.find((row) => row.id === "splitRight")?.accelerator).toBe("CmdOrCtrl+E");
    expect(accelerators?.find((row) => row.id === "closePane")?.accelerator).toBe("CmdOrCtrl+W");
    expect(accelerators?.find((row) => row.id === "revealInFinder")?.accelerator).toBeNull();
  });

  test("a reset to the defaults is sent too, so the menu forgets the old chord", () => {
    let sends = 0;
    const view = fakeSettingsView();

    view.set({ ...DEFAULT_GLOBAL_SETTINGS, commandShortcuts: { splitRight: "CmdOrCtrl+E" } });
    syncNativeShortcuts(() => {
      sends += 1;

      return Promise.resolve();
    }, view);

    view.set(DEFAULT_GLOBAL_SETTINGS);

    expect(sends).toBe(2);
  });

  test("recording releases every accelerator, so the menu cannot swallow the chord", () => {
    const sent: (readonly MenuAccelerator[])[] = [];
    const view = fakeSettingsView();

    syncNativeShortcuts((accelerators) => {
      sent.push(accelerators);

      return Promise.resolve();
    }, view);

    view.record(true);

    const [released] = sent;

    expect(sent).toHaveLength(1);
    expect(released?.length).toBeGreaterThan(0);
    expect(released?.every((row) => row.accelerator === null)).toBe(true);

    view.record(false);

    const restored = sent[1];

    expect(sent).toHaveLength(2);
    expect(restored?.find((row) => row.id === "newSession")?.accelerator).toBe("CmdOrCtrl+N");
  });

  test("a shell that refuses the table is a warning, never a thrown error", () => {
    const view = fakeSettingsView();

    syncNativeShortcuts(() => Promise.reject(new Error("no menu")), view);

    expect(() => {
      view.set({ ...DEFAULT_GLOBAL_SETTINGS, commandShortcuts: { splitRight: "CmdOrCtrl+E" } });
    }).not.toThrow();
  });
});
