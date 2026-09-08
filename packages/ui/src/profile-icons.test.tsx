import { describe, expect, test } from "bun:test";

import { BUILT_IN_PROFILES } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FALLBACK_ICON_NAME,
  iconForName,
  isProfileIconName,
  PROFILE_ICON_NAMES,
  ProfileIcon,
} from "./profile-icons.tsx";

describe("the icon table", () => {
  test("resolves every name it offers", () => {
    for (const name of PROFILE_ICON_NAMES) {
      expect(isProfileIconName(name)).toBe(true);
    }
  });

  test("covers every icon the built-in profiles name", () => {
    // Otherwise a profile Janela ships with renders the fallback, which is the
    // one case where the fallback would be our bug rather than the user's typo.
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
    // Not fooled by inherited object properties.
    expect(isProfileIconName("toString")).toBe(false);
    expect(isProfileIconName("constructor")).toBe(false);
  });
});

describe("rendering", () => {
  test("an unrecognised name falls back rather than rendering nothing", () => {
    const misspelled = renderToStaticMarkup(<ProfileIcon iconName="sparkle" />);
    const fallback = renderToStaticMarkup(<ProfileIcon iconName={FALLBACK_ICON_NAME} />);

    expect(misspelled).toContain("<svg");
    expect(misspelled).toBe(fallback);
  });

  test("a recognised name renders its own glyph, not the fallback", () => {
    const sparkles = renderToStaticMarkup(<ProfileIcon iconName="sparkles" />);
    const fallback = renderToStaticMarkup(<ProfileIcon iconName={FALLBACK_ICON_NAME} />);
    expect(sparkles).toContain("<svg");
    expect(sparkles).not.toBe(fallback);
  });

  test("the glyph is hidden from assistive technology", () => {
    // Every call site puts the name, title or an aria-label beside it, so
    // announcing the glyph would read the same thing twice.
    expect(renderToStaticMarkup(<ProfileIcon iconName="sparkles" />)).toContain(
      'aria-hidden="true"',
    );
  });

  test("iconForName is total: every offered name yields a component", () => {
    for (const name of [...PROFILE_ICON_NAMES, "definitely-not-an-icon"]) {
      expect(typeof iconForName(name)).not.toBe("undefined");
    }
  });
});
