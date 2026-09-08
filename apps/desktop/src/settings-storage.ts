import type { LaunchProfileID } from "@janela/core";
import {
  DEFAULT_GLOBAL_SETTINGS,
  withTerminalFontSize,
  type GlobalSettings,
  type SettingsStoring,
} from "@janela/ui";

/**
 * Global settings, in `localStorage`.
 *
 * Not on the wire and not in the database, because every field is about rendering
 * or interrupting and both are facts a *client* holds — a CLI has no use for a font
 * size (`global-settings.ts` § Why this is client state).
 *
 * `localStorage` rather than a file: it is the WebView's own store, it survives an
 * app update, and reaching for the filesystem would mean a Rust command, a
 * permission and a path — for two numbers and a boolean.
 */
const KEY = "janela.settings";

export function localStorageSettings(storage: Storage = localStorage): SettingsStoring {
  return {
    load(): Promise<GlobalSettings> {
      // Anything unreadable is the defaults, by the port's own contract: settings
      // that refuse to load must not stop the window from painting.
      return Promise.resolve(parseSettings(readRaw(storage)));
    },

    save(settings: GlobalSettings): Promise<void> {
      try {
        storage.setItem(KEY, JSON.stringify(settings));
      } catch {
        // A full or disabled store loses a preference, not the session.
      }
      return Promise.resolve();
    },
  };
}

function readRaw(storage: Storage): string | null {
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * Parses what was stored, field by field.
 *
 * Field by field rather than trusting the blob: this is data an older build wrote,
 * and one bad field must cost that field rather than every setting. The font size
 * goes through `withTerminalFontSize`, so the bounds are enforced in one place.
 */
export function parseSettings(raw: string | null): GlobalSettings {
  if (raw === null) return DEFAULT_GLOBAL_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_GLOBAL_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_GLOBAL_SETTINGS;

  const stored = parsed as {
    readonly terminalFontFamily?: unknown;
    readonly terminalFontSize?: unknown;
    readonly notifiesOnBell?: unknown;
    readonly defaultProfileID?: unknown;
  };

  let settings: GlobalSettings = {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...(typeof stored.notifiesOnBell === "boolean"
      ? { notifiesOnBell: stored.notifiesOnBell }
      : {}),
    ...(typeof stored.terminalFontFamily === "string" && stored.terminalFontFamily.length > 0
      ? { terminalFontFamily: stored.terminalFontFamily }
      : {}),
    ...(typeof stored.defaultProfileID === "string"
      ? { defaultProfileID: stored.defaultProfileID as LaunchProfileID }
      : {}),
  };

  if (typeof stored.terminalFontSize === "number") {
    settings = withTerminalFontSize(settings, stored.terminalFontSize);
  }
  return settings;
}
