import { describe, expect, test } from "bun:test";

import { UnexpectedFailure, UserFacingError, isUserFacing } from "./errors.ts";

describe("the shown-or-logged rule", () => {
  test("an ordinary Error is not user-facing, so it gets logged rather than shown", () => {
    expect(isUserFacing(new Error("ENOENT: no such file or directory, open '/x/y'"))).toBe(false);
    expect(isUserFacing("a string")).toBe(false);
    expect(isUserFacing(undefined)).toBe(false);
  });

  test("UnexpectedFailure shows a summary and keeps the underlying error for the log", () => {
    const underlying = new Error("EPERM: operation not permitted, symlink");
    const failure = new UnexpectedFailure("Couldn't create the worktree.", underlying);

    expect(isUserFacing(failure)).toBe(true);
    expect(failure.summary).toBe("Couldn't create the worktree.");
    // The raw error never reaches the headline. That is the whole rule.
    expect(failure.summary).not.toContain("EPERM");
    expect(failure.underlying).toBe(underlying);
    expect(failure.recoverySuggestion).toBeDefined();
  });

  test("the class name survives subclassing, so a log line names the real failure", () => {
    const failure = new UnexpectedFailure("Nope.", new Error("x"));
    expect(failure.name).toBe("UnexpectedFailure");
    expect(failure instanceof UserFacingError).toBe(true);
    expect(failure instanceof Error).toBe(true);
  });
});
