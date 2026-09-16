import { describe, expect, test } from "bun:test";

import { fakeProfile } from "../../../shared/lib/test-fakes/index.ts";
import { blankProfile } from "../../../shared/model/index.ts";
import {
  canRemoveProfile,
  canRenameProfile,
  duplicatedProfile,
  profileViolations,
} from "./profile-rules.ts";

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
    expect(copy.id).not.toBe(built.id);
    expect(copy.command).toEqual(built.command);
  });
});

describe("a blank profile", () => {
  test("is refused until it has a name and an executable", () => {
    expect(profileViolations(blankProfile())).toEqual([
      "A profile needs a name.",
      "The first argument is the executable, and cannot be blank.",
    ]);
  });
});
