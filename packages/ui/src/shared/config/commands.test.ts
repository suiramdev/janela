import { describe, expect, test } from "bun:test";

import { COMMANDS, availableCommands, isCommandID } from "./commands.ts";

const chordOf = (id: string): string | undefined =>
  COMMANDS.find((command) => command.id === id)?.accelerator;

describe("the command table", () => {
  test("every id appears once: the palette and the menu bar read this list", () => {
    const ids = COMMANDS.map((command) => command.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no chord takes a key from the program running in the terminal", () => {
    for (const command of COMMANDS) {
      const { accelerator } = command;

      if (accelerator === undefined) continue;

      expect(accelerator.startsWith("CmdOrCtrl+")).toBe(true);
      expect(accelerator.replace("CmdOrCtrl+", "")).not.toContain("Ctrl");
    }
  });

  test("⌘W closes a pane, which is why the window has no Close item", () => {
    const owner = COMMANDS.find((command) => command.accelerator === "CmdOrCtrl+W");

    expect(owner?.id).toBe("closePane");
  });

  test("the bracket pair switches sessions, one level up from tabs", () => {
    expect(chordOf("nextSession")).toBe("CmdOrCtrl+Shift+]");
    expect(chordOf("nextTab")).toBe("CmdOrCtrl+]");
  });
});

describe("isCommandID", () => {
  test("names a row, and nothing that merely exists on an object", () => {
    expect(isCommandID("splitRight")).toBe(true);
    expect(isCommandID("nope")).toBe(false);
    expect(isCommandID("constructor")).toBe(false);
    expect(isCommandID("toString")).toBe(false);
  });
});

describe("availableCommands", () => {
  test("a local shell unlocks exactly the commands that need the Mac", () => {
    const missing = COMMANDS.filter((command) => !availableCommands(false).includes(command));

    expect(missing.map((command) => command.id)).toEqual([
      "checkForUpdates",
      "stopDaemon",
      "revealInFinder",
      "openInTerminal",
    ]);
    expect(availableCommands(true)).toBe(COMMANDS);
  });
});
