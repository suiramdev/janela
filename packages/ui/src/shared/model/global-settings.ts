import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionEvent,
  type AttentionEventPreference,
  type AttentionPreferences,
} from "@janela/client";

import type { CommandID } from "../config/index.ts";

export type CommandShortcuts = Readonly<Partial<Record<CommandID, string>>>;

export type ThemePreference = "system" | "light" | "dark";

export interface GlobalSettings {
  readonly theme: ThemePreference;

  readonly terminalFontFamily?: string;

  readonly terminalFontSize: number;

  readonly notifications: AttentionPreferences;

  readonly silencedConfirmations?: readonly ConfirmationKey[];

  readonly commandShortcuts?: CommandShortcuts;
}

export type ConfirmationKey = "closeTerminals";

export interface SettingsStoring {
  load(): Promise<GlobalSettings>;
  save(settings: GlobalSettings): Promise<void>;
}

export const TERMINAL_FONT_SIZE_BOUNDS = { minimum: 8, maximum: 32 } as const;

export const DEFAULT_TERMINAL_FONT_SIZE = 13;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  theme: "system",
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  notifications: DEFAULT_ATTENTION_PREFERENCES,
};

export const CONFIRMATION_KEYS: readonly ConfirmationKey[] = ["closeTerminals"];

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export const THEME_TITLE = {
  system: "System",
  light: "Light",
  dark: "Dark",
} as const satisfies Record<ThemePreference, string>;

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.some((candidate) => candidate === value);
}

export function withTheme(settings: GlobalSettings, theme: ThemePreference): GlobalSettings {
  return settings.theme === theme ? settings : { ...settings, theme };
}

export function withNotificationEvent(
  settings: GlobalSettings,
  event: AttentionEvent,
  preference: AttentionEventPreference,
): GlobalSettings {
  const notifications = { ...settings.notifications, [event]: preference };

  return { ...settings, notifications };
}

export function withTerminalFontFamily(settings: GlobalSettings, family: string): GlobalSettings {
  const trimmed = family.trim();

  if (trimmed.length === 0) {
    const { terminalFontFamily: _removed, ...rest } = settings;

    return rest;
  }

  return { ...settings, terminalFontFamily: trimmed };
}

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

export function isConfirmationSilenced(settings: GlobalSettings, key: ConfirmationKey): boolean {
  return settings.silencedConfirmations?.includes(key) ?? false;
}

export function withSilencedConfirmation(
  settings: GlobalSettings,
  key: ConfirmationKey,
  silenced: boolean,
): GlobalSettings {
  const current = settings.silencedConfirmations ?? [];

  if (silenced === current.includes(key)) return settings;

  const next = silenced ? [...current, key] : current.filter((each) => each !== key);

  if (next.length === 0) {
    const { silencedConfirmations: _removed, ...rest } = settings;

    return rest;
  }

  return { ...settings, silencedConfirmations: next };
}
