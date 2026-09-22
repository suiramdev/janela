import { describe, expect, test } from "bun:test";

import { SILENT_NOTIFICATION_SOUND } from "@janela/client";
import { absolutePath } from "@janela/core";

import {
  DEFAULT_GLOBAL_SETTINGS,
  TERMINAL_FONT_SIZE_BOUNDS,
  withCommandShortcut,
  withNotificationEvent,
  withSilencedConfirmation,
} from "../../model/index.ts";
import { localStorageSettings, parseSettings } from "./settings-storage.ts";

function memoryStorage(initial: string | undefined = undefined): Storage {
  const entries = new Map<string, string>();

  if (initial !== undefined) entries.set("janela.settings", initial);

  return {
    get length(): number {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe("parseSettings", () => {
  test("nothing stored, and anything unparsable, is the defaults", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(parseSettings("not json")).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(parseSettings("[1,2,3]")).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  test("one bad field costs that field, not every setting", () => {
    const settings = parseSettings(
      JSON.stringify({
        terminalFontSize: "big",
        notifications: { bell: { notifies: true } },
      }),
    );

    expect(settings.terminalFontSize).toBe(DEFAULT_GLOBAL_SETTINGS.terminalFontSize);
    expect(settings.notifications.bell.notifies).toBe(true);
  });

  test("a file written before the agent switches existed keeps them on", () => {
    const settings = parseSettings(JSON.stringify({ terminalFontSize: 14 }));

    expect(settings.notifications.waiting.notifies).toBe(true);
    expect(settings.notifications.finished.notifies).toBe(true);
    expect(settings.notifications.failed.notifies).toBe(true);
  });

  test("one event's switch is read without disturbing the other events", () => {
    const settings = parseSettings(
      JSON.stringify({ notifications: { failed: { notifies: false } } }),
    );

    expect(settings.notifications.failed.notifies).toBe(false);
    expect(settings.notifications.finished.notifies).toBe(true);
  });

  test("a bad event reads as the defaults, and costs no other event", () => {
    const settings = parseSettings(
      JSON.stringify({
        notifications: { waiting: "loud", failed: { notifies: false } },
      }),
    );

    expect(settings.notifications.waiting).toEqual(DEFAULT_GLOBAL_SETTINGS.notifications.waiting);
    expect(settings.notifications.failed.notifies).toBe(false);
  });

  test("a field this version retired reads as the defaults, not as itself", () => {
    const settings = parseSettings(JSON.stringify({ retiredSetting: "yes" }));

    expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(Object.hasOwn(settings, "retiredSetting")).toBe(false);
  });

  test("a held theme comes back; a theme this version does not know is System", () => {
    expect(parseSettings(JSON.stringify({ theme: "dark" })).theme).toBe("dark");
    expect(parseSettings(JSON.stringify({ theme: "light" })).theme).toBe("light");
    expect(parseSettings(JSON.stringify({ theme: "neon" })).theme).toBe("system");
    expect(parseSettings(JSON.stringify({ theme: 2 })).theme).toBe("system");
  });

  test("a font size from another era is clamped rather than trusted", () => {
    expect(parseSettings(JSON.stringify({ terminalFontSize: 400 })).terminalFontSize).toBe(
      TERMINAL_FONT_SIZE_BOUNDS.maximum,
    );

    expect(parseSettings(JSON.stringify({ terminalFontSize: 1 })).terminalFontSize).toBe(
      TERMINAL_FONT_SIZE_BOUNDS.minimum,
    );
  });

  test("an empty font family is no override, not a font that renders nothing", () => {
    expect(parseSettings(JSON.stringify({ terminalFontFamily: "" }))).toEqual(
      DEFAULT_GLOBAL_SETTINGS,
    );

    expect(parseSettings(JSON.stringify({ terminalFontFamily: "Menlo" })).terminalFontFamily).toBe(
      "Menlo",
    );
  });

  test("a chosen sound comes back as the sound, an unplayable one as silence", () => {
    expect(
      parseSettings(
        JSON.stringify({
          notifications: { failed: { sound: { kind: "system", name: "Submarine" } } },
        }),
      ).notifications.failed.sound,
    ).toEqual({ kind: "system", name: "Submarine" });

    expect(
      parseSettings(
        JSON.stringify({
          notifications: { bell: { sound: { kind: "custom", path: "/Users/me/ping.aiff" } } },
        }),
      ).notifications.bell.sound,
    ).toEqual({ kind: "custom", path: absolutePath("/Users/me/ping.aiff") });

    for (const stored of [
      { kind: "system", name: "NoSuchSound" },
      { kind: "custom", path: "relative.aiff" },
      { kind: "custom" },
      { kind: "elsewhere" },
    ]) {
      expect(
        parseSettings(JSON.stringify({ notifications: { waiting: { sound: stored } } }))
          .notifications.waiting.sound,
      ).toEqual(DEFAULT_GLOBAL_SETTINGS.notifications.waiting.sound);
    }
  });

  test("an unplayable sound costs the sound, not the switch beside it", () => {
    const settings = parseSettings(
      JSON.stringify({
        notifications: { bell: { notifies: true, sound: { kind: "system", name: "NoSuchSound" } } },
      }),
    );

    expect(settings.notifications.bell.notifies).toBe(true);
    expect(settings.notifications.bell.sound).toEqual(SILENT_NOTIFICATION_SOUND);
  });

  test("each event keeps its own sound", () => {
    const settings = parseSettings(
      JSON.stringify({
        notifications: {
          waiting: { sound: { kind: "system", name: "Submarine" } },
          failed: { sound: { kind: "system", name: "Basso" } },
        },
      }),
    );

    expect(settings.notifications.waiting.sound).toEqual({ kind: "system", name: "Submarine" });
    expect(settings.notifications.failed.sound).toEqual({ kind: "system", name: "Basso" });
    expect(settings.notifications.finished.sound).toEqual(SILENT_NOTIFICATION_SOUND);
  });
});

describe("localStorageSettings", () => {
  test("a saved setting comes back", async () => {
    const storage = memoryStorage();
    const store = localStorageSettings(storage);

    await store.save({ ...DEFAULT_GLOBAL_SETTINGS, terminalFontSize: 16 });

    expect((await store.load()).terminalFontSize).toBe(16);
  });

  test("an agent switch turned off survives the round trip", async () => {
    const storage = memoryStorage();
    const store = localStorageSettings(storage);

    const quiet = withNotificationEvent(DEFAULT_GLOBAL_SETTINGS, "finished", {
      notifies: false,
      sound: { kind: "system", name: "Submarine" },
    });

    await store.save(
      withNotificationEvent(quiet, "waiting", {
        notifies: false,
        sound: SILENT_NOTIFICATION_SOUND,
      }),
    );

    const loaded = await store.load();

    expect(loaded.notifications.finished.notifies).toBe(false);
    expect(loaded.notifications.finished.sound).toEqual({ kind: "system", name: "Submarine" });
    expect(loaded.notifications.waiting.notifies).toBe(false);
  });

  test("a store that refuses to write loses a preference, not the session", async () => {
    const refusing: Storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    await localStorageSettings(refusing).save(DEFAULT_GLOBAL_SETTINGS);
  });
});

describe("silenced confirmations", () => {
  test("a silenced question survives a round trip", async () => {
    const storage = memoryStorage();
    const store = localStorageSettings(storage);

    await store.save(withSilencedConfirmation(DEFAULT_GLOBAL_SETTINGS, "closeTerminals", true));

    expect((await store.load()).silencedConfirmations).toEqual(["closeTerminals"]);
  });

  test("a key this build does not know is dropped", () => {
    const settings = parseSettings(
      JSON.stringify({ silencedConfirmations: ["closeTerminals", "removeEverything"] }),
    );

    expect(settings.silencedConfirmations).toEqual(["closeTerminals"]);
  });

  test("nothing silenced is an absent key, not an empty list", () => {
    expect(Object.hasOwn(parseSettings(JSON.stringify({})), "silencedConfirmations")).toBe(false);
    expect(
      Object.hasOwn(
        parseSettings(JSON.stringify({ silencedConfirmations: [] })),
        "silencedConfirmations",
      ),
    ).toBe(false);

    expect(
      Object.hasOwn(
        parseSettings(JSON.stringify({ silencedConfirmations: "yes" })),
        "silencedConfirmations",
      ),
    ).toBe(false);
  });
});

describe("command shortcuts", () => {
  test("an override survives a round trip", async () => {
    const storage = memoryStorage();
    const store = localStorageSettings(storage);

    await store.save(withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "splitRight", "CmdOrCtrl+E"));

    expect((await store.load()).commandShortcuts).toEqual({ splitRight: "CmdOrCtrl+E" });
  });

  test("an id this build does not know, or a chord outside the grammar, is dropped", () => {
    const settings = parseSettings(
      JSON.stringify({
        commandShortcuts: {
          splitRight: "CmdOrCtrl+E",
          launchRockets: "CmdOrCtrl+L",
          closePane: "Ctrl+W",
          nextTab: 7,
        },
      }),
    );

    expect(settings.commandShortcuts).toEqual({ splitRight: "CmdOrCtrl+E" });
  });

  test("a stored chord that is the default again is not an override", () => {
    const settings = parseSettings(
      JSON.stringify({ commandShortcuts: { closePane: "CmdOrCtrl+W" } }),
    );

    expect(Object.hasOwn(settings, "commandShortcuts")).toBe(false);
  });
});
