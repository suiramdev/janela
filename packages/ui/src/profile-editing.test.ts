import { describe, expect, test } from "bun:test";

import {
  argumentDrafts,
  argumentsAppending,
  argvOf,
  blankProfile,
  canRemoveProfile,
  canRenameProfile,
  duplicatedProfile,
  environmentOf,
  profileDraft,
  profileOf,
  profileViolations,
  variableDrafts,
  variablesAppending,
} from "./profile-editing.ts";
import { fakeProfile } from "./test-fakes.ts";

describe("argv drafts", () => {
  test("every element gets its own identity, so removal does not renumber the rest", () => {
    const drafts = argumentDrafts(["zsh", "-lc", "echo hi"]);
    const ids = drafts.map((draft) => draft.id);
    expect(new Set(ids).size).toBe(3);

    const withoutSecond = drafts.filter((draft) => draft.id !== ids[1]);
    expect(withoutSecond).toHaveLength(2);
    expect(argvOf(withoutSecond)).toEqual(["zsh", "echo hi"]);
  });

  test("values round-trip verbatim, spaces and empties included", () => {
    // The property that makes "argv is always an array" true: no splitting, no
    // trimming, no dropping. Anything else would edit the user's command.
    const argv = ["zsh", "-lc", "echo 'a b'  | wc", "", "  "];
    expect(argvOf(argumentDrafts(argv))).toEqual(argv);
  });

  test("an empty argv is a value, not an error — it means the login shell", () => {
    expect(argvOf(argumentDrafts([]))).toEqual([]);
  });

  test("appending adds one blank element with a fresh id", () => {
    const drafts = argumentsAppending(argumentDrafts(["claude"]));
    expect(argvOf(drafts)).toEqual(["claude", ""]);
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(2);
  });

  test("two identical arguments stay two distinct rows", () => {
    const drafts = argumentDrafts(["make", "-j", "-j"]);
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(3);
    expect(argvOf(drafts)).toEqual(["make", "-j", "-j"]);
  });
});

describe("environment drafts", () => {
  test("rows are sorted by name so saving does not reorder the editor", () => {
    const drafts = variableDrafts({ ZED: "1", ALPHA: "2", MIDDLE: "3" });
    expect(drafts.map((draft) => draft.key)).toEqual(["ALPHA", "MIDDLE", "ZED"]);
  });

  test("a blank name is a row the user has not finished, and is dropped", () => {
    const drafts = variablesAppending(variableDrafts({ EDITOR: "nvim" }));
    expect(environmentOf(drafts)).toEqual({ EDITOR: "nvim" });
  });

  test("whitespace around a name is trimmed, but never around a value", () => {
    const record = environmentOf([{ id: "a", key: "  EDITOR  ", value: "  nvim  " }]);
    expect(record).toEqual({ EDITOR: "  nvim  " });
  });

  test("a repeated name keeps the last row, as a process's environment does", () => {
    const record = environmentOf([
      { id: "a", key: "EDITOR", value: "vi" },
      { id: "b", key: "EDITOR", value: "nvim" },
    ]);
    expect(record).toEqual({ EDITOR: "nvim" });
  });

  test("an empty value is kept — it is how a variable is unset for a child", () => {
    expect(environmentOf([{ id: "a", key: "NO_COLOR", value: "" }])).toEqual({ NO_COLOR: "" });
  });
});

describe("the draft round trip", () => {
  test("a profile survives being opened and saved unchanged", () => {
    const profile = fakeProfile({
      command: ["zsh", "-lc", "claude --model opus"],
      environment: { EDITOR: "nvim", NO_COLOR: "1" },
    });
    expect(profileOf(profileDraft(profile))).toEqual(profile);
  });

  test("editing the name leaves the command alone", () => {
    const draft = profileDraft(fakeProfile({ command: ["claude", "--continue"] }));
    const renamed = profileOf({ ...draft, profile: { ...draft.profile, name: "Claude" } });
    expect(renamed.name).toBe("Claude");
    expect(renamed.command).toEqual(["claude", "--continue"]);
  });
});

describe("profileViolations", () => {
  test("a nameless profile cannot be saved", () => {
    expect(profileViolations(fakeProfile({ name: "   " }))).toEqual(["A profile needs a name."]);
  });

  test("a blank executable cannot be saved", () => {
    expect(profileViolations(fakeProfile({ command: ["  "] }))).toEqual([
      "The first argument is the executable, and cannot be blank.",
    ]);
  });

  test("a blank *later* argument is legal, because a program may want one", () => {
    expect(profileViolations(fakeProfile({ command: ["zsh", "-lc", ""] }))).toEqual([]);
  });

  test("an empty command is legal: it is the login shell", () => {
    expect(profileViolations(fakeProfile({ command: [] }))).toEqual([]);
  });

  test("an uninstalled executable is not a violation — that is availability's job", () => {
    expect(profileViolations(fakeProfile({ command: ["definitely-not-installed"] }))).toEqual([]);
  });
});

describe("built-in protection", () => {
  test("a built-in can be neither deleted nor renamed", () => {
    const built = fakeProfile({ isBuiltIn: true });
    expect(canRemoveProfile(built)).toBe(false);
    expect(canRenameProfile(built)).toBe(false);
  });

  test("a user profile can be both", () => {
    const mine = fakeProfile({ isBuiltIn: false });
    expect(canRemoveProfile(mine)).toBe(true);
    expect(canRenameProfile(mine)).toBe(true);
  });

  test("duplicating a built-in yields a copy the user owns", () => {
    const built = fakeProfile({ name: "Codex", isBuiltIn: true });
    const copy = duplicatedProfile(built);

    expect(copy.isBuiltIn).toBe(false);
    expect(canRemoveProfile(copy)).toBe(true);
    expect(canRenameProfile(copy)).toBe(true);
    expect(copy.name).toBe("Codex Copy");
    // A fresh id: reusing it would overwrite the built-in it was copied from.
    expect(copy.id).not.toBe(built.id);
    expect(copy.command).toEqual(built.command);
  });
});

describe("blankProfile", () => {
  test("opens with an executable field and says what is missing", () => {
    const blank = blankProfile();
    expect(blank.command).toEqual([""]);
    expect(blank.isBuiltIn).toBe(false);
    // Not silently valid: an empty command would be a login-shell profile the
    // user never asked for.
    expect(profileViolations(blank)).toEqual([
      "A profile needs a name.",
      "The first argument is the executable, and cannot be blank.",
    ]);
  });

  test("two blanks never share an id", () => {
    expect(blankProfile().id).not.toBe(blankProfile().id);
  });
});
