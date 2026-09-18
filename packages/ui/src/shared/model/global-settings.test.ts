import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_BOUNDS,
  attentionPreferences,
  withTerminalFontFamily,
  withTerminalFontSize,
} from "./global-settings.ts";

describe("the defaults", () => {
  test("declare no font override", () => {
    expect(Object.hasOwn(DEFAULT_GLOBAL_SETTINGS, "terminalFontFamily")).toBe(false);
  });

  test("leave the bell quiet", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.notifiesOnBell).toBe(false);
  });

  test("let an agent interrupt, because that is the report the user asked for", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.notifiesWhenAgentFinishes).toBe(true);
    expect(DEFAULT_GLOBAL_SETTINGS.notifiesWhenAgentWaits).toBe(true);
  });
});

describe("withTerminalFontFamily", () => {
  test("sets a trimmed family", () => {
    expect(withTerminalFontFamily(DEFAULT_GLOBAL_SETTINGS, "  Berkeley Mono  ")).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS,
      terminalFontFamily: "Berkeley Mono",
    });
  });

  test("a blank family removes the key rather than storing undefined", () => {
    const overridden = withTerminalFontFamily(DEFAULT_GLOBAL_SETTINGS, "Berkeley Mono");
    const cleared = withTerminalFontFamily(overridden, "   ");

    expect(Object.hasOwn(cleared, "terminalFontFamily")).toBe(false);
  });
});

describe("withTerminalFontSize", () => {
  test("clamps into the bounds", () => {
    expect(withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 2).terminalFontSize).toBe(
      TERMINAL_FONT_SIZE_BOUNDS.minimum,
    );
    expect(withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 999).terminalFontSize).toBe(
      TERMINAL_FONT_SIZE_BOUNDS.maximum,
    );
  });

  test("keeps a size inside the bounds, rounded to a whole point", () => {
    expect(withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 14.4).terminalFontSize).toBe(14);
  });

  test("a non-number falls back to the default rather than propagating NaN", () => {
    expect(withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, Number.NaN).terminalFontSize).toBe(
      DEFAULT_TERMINAL_FONT_SIZE,
    );
    expect(
      withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, Number.POSITIVE_INFINITY).terminalFontSize,
    ).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  test("leaves the rest of the settings alone", () => {
    const settings = withTerminalFontFamily(DEFAULT_GLOBAL_SETTINGS, "Menlo");

    expect(withTerminalFontSize(settings, 16).terminalFontFamily).toBe("Menlo");
  });
});

describe("attentionPreferences", () => {
  test("carries the three notification switches and nothing else", () => {
    expect(
      attentionPreferences({
        ...DEFAULT_GLOBAL_SETTINGS,
        terminalFontFamily: "Menlo",
        notifiesOnBell: true,
        notifiesWhenAgentWaits: false,
      }),
    ).toEqual({
      notifiesOnBell: true,
      notifiesWhenAgentFinishes: true,
      notifiesWhenAgentWaits: false,
    });
  });
});
