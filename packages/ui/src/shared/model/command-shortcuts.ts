import {
  COMMAND_BY_ID,
  type Command,
  type CommandID,
  acceleratorCapTokens,
  availableCommands,
  parseAccelerator,
  sameAccelerator,
} from "../config/index.ts";
import type { CommandShortcuts, GlobalSettings } from "./global-settings.ts";

export const SHORTCUT_GRAMMAR_MESSAGE =
  "A shortcut is ⌘ and a key, with ⇧ or ⌥ if you like. Ctrl stays with the program in the terminal.";

export function commandsWithShortcuts(
  settings: GlobalSettings,
  hasLocalShell: boolean,
): readonly Command[] {
  const overrides = settings.commandShortcuts;
  const base = availableCommands(hasLocalShell);

  if (overrides === undefined) return base;

  return base.map((command) => {
    const accelerator = overrides[command.id];

    return accelerator === undefined ? command : { ...command, accelerator };
  });
}

export function defaultShortcut(id: CommandID): string | undefined {
  return COMMAND_BY_ID[id]?.accelerator;
}

export function isShortcutOverridden(settings: GlobalSettings, id: CommandID): boolean {
  return settings.commandShortcuts?.[id] !== undefined;
}

export function withCommandShortcut(
  settings: GlobalSettings,
  id: CommandID,
  accelerator: string | undefined,
): GlobalSettings {
  const current = settings.commandShortcuts ?? {};
  const fallback = defaultShortcut(id);
  const isDefault =
    accelerator === undefined || (fallback !== undefined && sameAccelerator(fallback, accelerator));

  if (isDefault) {
    if (current[id] === undefined) return settings;

    const { [id]: _removed, ...rest } = current;

    return withShortcuts(settings, rest);
  }

  if (current[id] === accelerator) return settings;

  return withShortcuts(settings, { ...current, [id]: accelerator });
}

export function shortcutViolation(
  settings: GlobalSettings,
  id: CommandID,
  accelerator: string,
): string | undefined {
  if (parseAccelerator(accelerator) === undefined) return SHORTCUT_GRAMMAR_MESSAGE;

  const owner = commandsWithShortcuts(settings, true).find(
    (command) =>
      command.id !== id &&
      command.accelerator !== undefined &&
      sameAccelerator(command.accelerator, accelerator),
  );

  return owner === undefined
    ? undefined
    : `${acceleratorCapTokens(accelerator).join("")} already means ${owner.title}.`;
}

function withShortcuts(settings: GlobalSettings, shortcuts: CommandShortcuts): GlobalSettings {
  if (Object.keys(shortcuts).length === 0) {
    const { commandShortcuts: _removed, ...rest } = settings;

    return rest;
  }

  return { ...settings, commandShortcuts: shortcuts };
}
