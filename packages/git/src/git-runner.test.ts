import { describe, expect, test } from "bun:test";

import { isUserFacing } from "@janela/support";

import { GitFailure } from "./git-runner.ts";

describe("GitFailure", () => {
  test("stderr goes in the reason, never the headline", () => {
    const stderr = "fatal: 'fix/pty' is already checked out at '/Users/x/.worktrees/fix-pty'";
    const failure = new GitFailure("worktree add", 128, stderr);

    expect(failure.summary).toBe("git worktree add failed.");
    expect(failure.summary).not.toContain("fatal:");
    expect(failure.reason).toBe(stderr);
    expect(failure.exitCode).toBe(128);
    expect(isUserFacing(failure)).toBe(true);
  });

  test("an empty stderr becomes no reason at all, not an empty sentence", () => {
    expect(new GitFailure("status", 1, "").reason).toBeUndefined();
  });
});
