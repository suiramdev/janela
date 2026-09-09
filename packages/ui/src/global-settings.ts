import type { LaunchProfileID } from "@janela/core";

/**
 * The settings that are not a project's.
 *
 * Small on purpose. A project is where the differences actually live, so a setting
 * earns a place here only when it is a fact about the person rather than about a
 * repository — and there is deliberately no per-session tier at all.
 *
 * ## Why this is client state and not daemon state
 *
 * Every field here is about *rendering* or *interrupting*, and both are facts only
 * a client holds. The font is a WebView's; the bell switch feeds the attention
 * policy, which lives in the client precisely because the daemon cannot know what
 * is on screen. A CLI has no use for any of it, which is the test for whether
 * something belongs on the wire.
 *
 * `defaultProfileID` is the one that looks like it should be shared, and is not:
 * it is the fallback for a project that has expressed no preference, and the
 * project's own `defaultProfileID` — which *is* daemon state — wins over it.
 */
export interface GlobalSettings {
  /**
   * Overrides `TERMINAL_FONT_STACK`. Absent means the default stack, which is not
   * the same as an empty string — an empty override would render nothing at all.
   */
  readonly terminalFontFamily?: string;

  readonly terminalFontSize: number;

  /**
   * Whether a bare BEL is allowed to interrupt.
   *
   * Off by default: programs ring the bell for reasons the user has not agreed are
   * important, so a bell badges the sidebar and stops there. An explicit OSC 9 or
   * OSC 777 always delivers regardless of this, because the program asked for a
   * notification by name and that is consent.
   */
  readonly notifiesOnBell: boolean;

  /** Profile for a new terminal when neither the project nor the user chose one. */
  readonly defaultProfileID?: LaunchProfileID;
}

/**
 * Font-size bounds.
 *
 * Not taste: below the minimum a terminal grid stops being legible and above the
 * maximum an 80-column view no longer fits a laptop display, and both ends produce
 * "the app is broken" reports rather than "the font is silly" reports.
 */
export const TERMINAL_FONT_SIZE_BOUNDS = { minimum: 8, maximum: 32 } as const;

export const DEFAULT_TERMINAL_FONT_SIZE = 13;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  notifiesOnBell: false,
};

/**
 * Applies a font-family override, treating blank input as "no override".
 *
 * The key is *removed* rather than set to `undefined`, because
 * `exactOptionalPropertyTypes` makes those different types and a persisted
 * `{"terminalFontFamily": null}` would read back as an override to nothing.
 */
export function withTerminalFontFamily(settings: GlobalSettings, family: string): GlobalSettings {
  const trimmed = family.trim();
  if (trimmed.length === 0) {
    const { terminalFontFamily: _removed, ...rest } = settings;
    return rest;
  }
  return { ...settings, terminalFontFamily: trimmed };
}

/**
 * Clamps into `TERMINAL_FONT_SIZE_BOUNDS`, and treats a non-number as the default.
 *
 * A number input yields `NaN` for an empty field and for "12pt", and `NaN` would
 * propagate into a CSS `font-size` that the WebView drops — leaving the terminal
 * at whatever it inherited, which looks like a rendering bug rather than a typo.
 */
export function withTerminalFontSize(settings: GlobalSettings, size: number): GlobalSettings {
  if (!Number.isFinite(size)) {
    return { ...settings, terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE };
  }
  const clamped = Math.min(
    TERMINAL_FONT_SIZE_BOUNDS.maximum,
    Math.max(TERMINAL_FONT_SIZE_BOUNDS.minimum, Math.round(size)),
  );
  return { ...settings, terminalFontSize: clamped };
}

/**
 * Sets or clears the global default profile.
 *
 * Same removal rule as the font family, for the same reason: "no global default"
 * has to survive a round trip through storage as an absent key.
 */
export function withDefaultProfileID(
  settings: GlobalSettings,
  profileID: LaunchProfileID | undefined,
): GlobalSettings {
  if (profileID === undefined) {
    const { defaultProfileID: _removed, ...rest } = settings;
    return rest;
  }
  return { ...settings, defaultProfileID: profileID };
}

/**
 * Where global settings are kept.
 *
 * A port, not an implementation: `@janela/ui` may not touch storage any more than
 * it may spawn a process. The composition root supplies one.
 *
 * `load` returning `DEFAULT_GLOBAL_SETTINGS` on a first launch — or on a file it
 * cannot parse — is the expected behaviour rather than an error: settings that
 * refuse to load must not stop the window from painting.
 */
export interface SettingsStoring {
  load(): Promise<GlobalSettings>;
  save(settings: GlobalSettings): Promise<void>;
}
