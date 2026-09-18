import { describe, expect, test } from "bun:test";

import { COMMANDS } from "../config/index.ts";
import {
  SHORTCUT_GRAMMAR_MESSAGE,
  commandsWithShortcuts,
  isShortcutOverridden,
  shortcutViolation,
  withCommandShortcut,
} from "./command-shortcuts.ts";
import { DEFAULT_GLOBAL_SETTINGS } from "./global-settings.ts";

const chordOf = (settings: Parameters<typeof commandsWithShortcuts>[0], id: string) =>
  commandsWithShortcuts(settings, true).find((command) => command.id === id)?.accelerator;

describe("commandsWithShortcuts", () => {
  test("with nothing overridden it is the table itself, not a copy", () => {
    expect(commandsWithShortcuts(DEFAULT_GLOBAL_SETTINGS, true)).toBe(COMMANDS);
  });

  test("an override replaces one chord and leaves the rest, in order", () => {
    const settings = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "splitRight", "CmdOrCtrl+E");
    const merged = commandsWithShortcuts(settings, true);

    expect(merged.map((command) => command.id)).toEqual(COMMANDS.map((command) => command.id));
    expect(chordOf(settings, "splitRight")).toBe("CmdOrCtrl+E");
    expect(chordOf(settings, "splitDown")).toBe("CmdOrCtrl+Shift+D");
  });

  test("a command with no chord can be given one", () => {
    const settings = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "revealInFinder", "CmdOrCtrl+R");

    expect(chordOf(settings, "revealInFinder")).toBe("CmdOrCtrl+R");
  });

  test("host-only commands stay hidden from a client without a local shell", () => {
    const settings = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "revealInFinder", "CmdOrCtrl+R");

    expect(commandsWithShortcuts(settings, false).map((command) => command.id)).not.toContain(
      "revealInFinder",
    );
  });
});

describe("withCommandShortcut", () => {
  test("setting the default again, in any spelling, is a reset rather than an override", () => {
    const changed = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "nextSession", "CmdOrCtrl+E");
    const back = withCommandShortcut(changed, "nextSession", "CmdOrCtrl+Shift+]");

    expect(isShortcutOverridden(changed, "nextSession")).toBe(true);
    expect(isShortcutOverridden(back, "nextSession")).toBe(false);
    expect(back).toEqual(DEFAULT_GLOBAL_SETTINGS);
  });

  test("undefined resets, and the last reset drops the map so nothing empty is stored", () => {
    const one = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "closePane", "CmdOrCtrl+Q");
    const reset = withCommandShortcut(one, "closePane", undefined);

    expect(Object.hasOwn(reset, "commandShortcuts")).toBe(false);
    expect(withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "closePane", undefined)).toBe(
      DEFAULT_GLOBAL_SETTINGS,
    );
  });

  test("the same override twice is the same settings object", () => {
    const one = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "closePane", "CmdOrCtrl+Q");

    expect(withCommandShortcut(one, "closePane", "CmdOrCtrl+Q")).toBe(one);
  });
});

describe("shortcutViolation", () => {
  test("a chord another command already answers to is named, by the title the user sees", () => {
    expect(shortcutViolation(DEFAULT_GLOBAL_SETTINGS, "splitRight", "CmdOrCtrl+W")).toBe(
      "⌘W already means Close Pane.",
    );
  });

  test("the conflict check reads the overrides, not only the table", () => {
    const settings = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "splitRight", "CmdOrCtrl+E");

    expect(shortcutViolation(settings, "splitDown", "CmdOrCtrl+E")).toBe(
      "⌘E already means Split Vertically.",
    );
    expect(shortcutViolation(settings, "splitDown", "CmdOrCtrl+D")).toBeUndefined();
  });

  test("a command's own chord is not a conflict with itself", () => {
    expect(shortcutViolation(DEFAULT_GLOBAL_SETTINGS, "closePane", "CmdOrCtrl+W")).toBeUndefined();
  });

  test("a chord outside the grammar is refused with the rule", () => {
    expect(shortcutViolation(DEFAULT_GLOBAL_SETTINGS, "closePane", "Ctrl+W")).toBe(
      SHORTCUT_GRAMMAR_MESSAGE,
    );
  });
});
