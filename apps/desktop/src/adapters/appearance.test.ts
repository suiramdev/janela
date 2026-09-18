import { describe, expect, test } from "bun:test";

import type { Theme } from "@tauri-apps/api/window";

import { tauriAppearance, type SchemeQuery } from "./appearance.ts";

interface FakeScheme extends SchemeQuery {
  flip(matches: boolean): void;
}

function fakeScheme(matches: boolean): FakeScheme {
  let listeners: (() => void)[] = [];
  let isDark = matches;

  return {
    get matches(): boolean {
      return isDark;
    },
    addEventListener(_type, listener) {
      listeners = [...listeners, listener];
    },
    flip(next) {
      isDark = next;

      for (const listener of listeners) listener();
    },
  };
}

describe("tauriAppearance", () => {
  test("System hands the window back to macOS; Light and Dark hold it", async () => {
    const set: (Theme | null)[] = [];
    const appearance = tauriAppearance({
      setTheme: async (theme) => {
        set.push(theme);
      },
      setDockIcon: async () => {},
      darkScheme: fakeScheme(false),
    });

    await appearance.apply("dark");
    await appearance.apply("system");
    await appearance.apply("light");

    expect(set).toEqual(["dark", null, "light"]);
  });

  test("the Dock icon follows what the window resolved to, not the preference", async () => {
    const dock: Theme[] = [];
    const scheme = fakeScheme(true);
    const appearance = tauriAppearance({
      setTheme: async () => {},
      setDockIcon: async (theme) => {
        dock.push(theme);
      },
      darkScheme: scheme,
    });

    await appearance.apply("system");
    scheme.flip(false);
    await Promise.resolve();

    expect(dock).toEqual(["dark", "light"]);
  });
});
