import type { AttentionPreferences } from "@janela/client";

import type { CommandID } from "../config/index.ts";

export type CommandShortcuts = Readonly<Partial<Record<CommandID, string>>>;

export interface GlobalSettings {
  readonly terminalFontFamily?: string;

  readonly terminalFontSize: number;

  readonly notifiesOnBell: boolean;

  readonly notifiesWhenAgentFinishes: boolean;

  readonly notifiesWhenAgentWaits: boolean;

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
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  notifiesOnBell: false,
  notifiesWhenAgentFinishes: true,
  notifiesWhenAgentWaits: true,
};

export const CONFIRMATION_KEYS: readonly ConfirmationKey[] = ["closeTerminals"];

export function attentionPreferences(settings: GlobalSettings): AttentionPreferences {
  return {
    notifiesOnBell: settings.notifiesOnBell,
    notifiesWhenAgentFinishes: settings.notifiesWhenAgentFinishes,
    notifiesWhenAgentWaits: settings.notifiesWhenAgentWaits,
  };
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
