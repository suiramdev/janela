import { describe, expect, test } from "bun:test";

import {
  type KeyChord,
  acceleratorCapTokens,
  acceleratorCaps,
  acceleratorForChord,
  parseAccelerator,
  sameAccelerator,
  spellAccelerator,
} from "./accelerators.ts";
import { COMMANDS } from "./commands.ts";

function chord(code: string, modifiers: Partial<KeyChord> = {}): KeyChord {
  return { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, code, ...modifiers };
}

describe("parseAccelerator", () => {
  test("every chord in the table parses, and spells back to itself", () => {
    for (const command of COMMANDS) {
      if (command.accelerator === undefined) continue;

      const keys = parseAccelerator(command.accelerator);

      expect(keys).toBeDefined();
      expect(keys === undefined ? undefined : spellAccelerator(keys)).toBe(command.accelerator);
    }
  });

  test("a chord without ⌘, or with Ctrl, is not a chord: those keys are the terminal's", () => {
    expect(parseAccelerator("Shift+D")).toBeUndefined();
    expect(parseAccelerator("Ctrl+D")).toBeUndefined();
    expect(parseAccelerator("CmdOrCtrl+Ctrl+D")).toBeUndefined();
    expect(parseAccelerator("D")).toBeUndefined();
  });

  test("a key it cannot name is refused rather than guessed", () => {
    expect(parseAccelerator("CmdOrCtrl+Escape")).toBeUndefined();
    expect(parseAccelerator("CmdOrCtrl+Tab")).toBeUndefined();
    expect(parseAccelerator("CmdOrCtrl+F13")).toBeUndefined();
    expect(parseAccelerator("CmdOrCtrl+")).toBeUndefined();
  });

  test("digits, punctuation, function keys and the named keys are all spellable", () => {
    for (const accelerator of [
      "CmdOrCtrl+1",
      "CmdOrCtrl+Shift+/",
      "CmdOrCtrl+Alt+F12",
      "CmdOrCtrl+Space",
      "CmdOrCtrl+Shift+Alt+Backspace",
    ]) {
      const keys = parseAccelerator(accelerator);

      expect(keys === undefined ? undefined : spellAccelerator(keys)).toBe(accelerator);
    }
  });
});

describe("acceleratorForChord", () => {
  test("spells what was pressed, modifiers in the table's order", () => {
    expect(acceleratorForChord(chord("KeyE"))).toBe("CmdOrCtrl+E");
    expect(acceleratorForChord(chord("BracketRight", { shiftKey: true }))).toBe(
      "CmdOrCtrl+Shift+]",
    );
    expect(acceleratorForChord(chord("ArrowLeft", { altKey: true, shiftKey: true }))).toBe(
      "CmdOrCtrl+Shift+Alt+Left",
    );
  });

  test("a press without ⌘, or with Ctrl, spells nothing", () => {
    expect(acceleratorForChord(chord("KeyE", { metaKey: false }))).toBeUndefined();
    expect(acceleratorForChord(chord("KeyE", { ctrlKey: true }))).toBeUndefined();
  });

  test("a bare modifier press spells nothing", () => {
    expect(acceleratorForChord(chord("ShiftLeft", { shiftKey: true }))).toBeUndefined();
    expect(acceleratorForChord(chord("MetaLeft"))).toBeUndefined();
  });
});

describe("sameAccelerator", () => {
  test("compares the chord, not the spelling", () => {
    expect(sameAccelerator("CmdOrCtrl+Shift+Alt+A", "CmdOrCtrl+Alt+Shift+A")).toBe(true);
    expect(sameAccelerator("CmdOrCtrl+]", "CmdOrCtrl+Shift+]")).toBe(false);
    expect(sameAccelerator("CmdOrCtrl+]", "nonsense")).toBe(false);
  });
});

describe("acceleratorCapTokens", () => {
  test("gives one token per cap, so prose and keycaps read the same chord", () => {
    expect(acceleratorCapTokens("CmdOrCtrl+Shift+]")).toEqual(["⌘", "⇧", "]"]);
    expect(acceleratorCapTokens("CmdOrCtrl+Shift+]").join("")).toBe("⌘⇧]");
  });
});

describe("acceleratorCaps", () => {
  test("renders the chord a Mac user reads, one token per cap", () => {
    expect(acceleratorCaps("CmdOrCtrl+Shift+]")).toBe("⌘+⇧+]");
    expect(acceleratorCaps("CmdOrCtrl+Alt+Left")).toBe("⌘+⌥+←");
    expect(acceleratorCaps("CmdOrCtrl+,")).toBe("⌘+,");
    expect(acceleratorCaps("CmdOrCtrl+Backspace")).toBe("⌘+⌫");
  });
});
