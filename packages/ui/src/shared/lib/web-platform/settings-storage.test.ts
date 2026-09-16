import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GLOBAL_SETTINGS,
  TERMINAL_FONT_SIZE_BOUNDS,
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
      JSON.stringify({ terminalFontSize: "big", notifiesOnBell: true }),
    );

    expect(settings.terminalFontSize).toBe(DEFAULT_GLOBAL_SETTINGS.terminalFontSize);
    expect(settings.notifiesOnBell).toBe(true);
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
});

describe("localStorageSettings", () => {
  test("a saved setting comes back", async () => {
    const storage = memoryStorage();
    const store = localStorageSettings(storage);

    await store.save({ ...DEFAULT_GLOBAL_SETTINGS, terminalFontSize: 16 });

    expect((await store.load()).terminalFontSize).toBe(16);
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
