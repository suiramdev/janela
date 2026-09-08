import { describe, expect, test } from "bun:test";

import { newLaunchProfileID } from "@janela/core";

import {
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_BOUNDS,
  withDefaultProfileID,
  withTerminalFontFamily,
  withTerminalFontSize,
} from "./global-settings.ts";

describe("the defaults", () => {
  test("declare no font override and no default profile", () => {
    // Absent, not empty: an empty font family would render nothing, and an empty
    // profile id would name a profile that does not exist.
    expect("terminalFontFamily" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
    expect("defaultProfileID" in DEFAULT_GLOBAL_SETTINGS).toBe(false);
  });

  test("leave the bell quiet", () => {
    // A bell means whatever the program ringing it decided, so it badges the
    // sidebar and stops there until the user opts in.
    expect(DEFAULT_GLOBAL_SETTINGS.notifiesOnBell).toBe(false);
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
    // `exactOptionalPropertyTypes` makes absent and `undefined` different types,
    // and a persisted `{"terminalFontFamily": null}` would read back as an
    // override to nothing.
    const overridden = withTerminalFontFamily(DEFAULT_GLOBAL_SETTINGS, "Berkeley Mono");
    const cleared = withTerminalFontFamily(overridden, "   ");
    expect("terminalFontFamily" in cleared).toBe(false);
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
    // An empty number field yields NaN, and a NaN `font-size` is dropped by the
    // WebView — which looks like a rendering bug rather than a typo.
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

describe("withDefaultProfileID", () => {
  test("sets a profile", () => {
    const profileID = newLaunchProfileID();
    expect(withDefaultProfileID(DEFAULT_GLOBAL_SETTINGS, profileID).defaultProfileID).toBe(
      profileID,
    );
  });

  test("clearing removes the key, so 'no default' survives a round trip", () => {
    const set = withDefaultProfileID(DEFAULT_GLOBAL_SETTINGS, newLaunchProfileID());
    expect("defaultProfileID" in withDefaultProfileID(set, undefined)).toBe(false);
  });
});
