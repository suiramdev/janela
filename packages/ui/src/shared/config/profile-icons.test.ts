import { describe, expect, test } from "bun:test";

import { BUILT_IN_PROFILES } from "@janela/core";

import {
  FALLBACK_ICON_NAME,
  PROFILE_ICON_NAMES,
  iconForName,
  isProfileIconName,
} from "./profile-icons.ts";

describe("the icon table", () => {
  test("resolves every name it offers", () => {
    for (const name of PROFILE_ICON_NAMES) {
      expect(isProfileIconName(name)).toBe(true);
    }
  });

  test("covers every icon the built-in profiles name", () => {
    for (const built of BUILT_IN_PROFILES) {
      expect(isProfileIconName(built.iconName)).toBe(true);
    }
  });

  test("includes the fallback itself", () => {
    expect(isProfileIconName(FALLBACK_ICON_NAME)).toBe(true);
  });

  test("an unrecognised name is not silently in the set", () => {
    expect(isProfileIconName("sparkle")).toBe(false);
    expect(isProfileIconName("")).toBe(false);
    expect(isProfileIconName("toString")).toBe(false);
    expect(isProfileIconName("constructor")).toBe(false);
  });
});

describe("iconForName", () => {
  test("is total: every offered name yields a glyph, and so does one it does not know", () => {
    for (const name of [...PROFILE_ICON_NAMES, "definitely-not-an-icon"]) {
      expect(iconForName(name)).toBeDefined();
    }
  });
});
