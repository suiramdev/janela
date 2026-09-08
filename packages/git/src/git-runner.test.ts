import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";

import type { AbsolutePath } from "@janela/core";
import { isUserFacing } from "@janela/support";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import { GitFailure, GitNotFound, gitRunner } from "./git-runner.ts";

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

/**
 * A stand-in `git` that reports how it was invoked: the lock setting on its
 * first line, then one argument per line.
 *
 * Real git cannot answer "what environment did you get, and was my argv split?",
 * which is the only thing these tests are about. Worktree behaviour is tested
 * against real repositories in `worktree-service.test.ts`.
 */
async function fakeGit(
  label: string,
): Promise<AsyncDisposable & { readonly directory: AbsolutePath }> {
  const temporary = await temporaryDirectory(label);
  const script = temporary.join("git");
  await writeFile(
    script,
    '#!/bin/sh\necho "${GIT_OPTIONAL_LOCKS-unset}"\nfor argument in "$@"; do echo "$argument"; done\n',
    "utf8",
  );
  await chmod(script, 0o755);
  return {
    directory: temporary.path as AbsolutePath,
    [Symbol.asyncDispose]: () => temporary[Symbol.asyncDispose](),
  };
}

describe("gitRunner", () => {
  test("git is resolved from the given PATH, not a hardcoded location", async () => {
    await using fake = await fakeGit("git-path");

    const output = await gitRunner({ environment: { PATH: fake.directory } }).run(
      ["--version"],
      fake.directory,
    );

    // The real git would print "git version …"; this one echoes its argv.
    expect(output.trimEnd().split("\n")).toEqual(["unset", "-C", fake.directory, "--version"]);
  });

  test("every invocation is scoped with -C and arguments are passed as an array", async () => {
    await using fake = await fakeGit("git-argv");

    const output = await gitRunner({ environment: { PATH: fake.directory } }).run(
      ["status", "a b"],
      fake.directory,
    );

    // `a b` arriving as one argument is the no-shell rule; the leading `0` is
    // GIT_OPTIONAL_LOCKS on a read-only command.
    expect(output.trimEnd().split("\n")).toEqual(["0", "-C", fake.directory, "status", "a b"]);
  });

  test("write commands do not set GIT_OPTIONAL_LOCKS", async () => {
    await using fake = await fakeGit("git-locks");
    const runner = gitRunner({ environment: { PATH: fake.directory } });

    // `worktree add` writes even though `worktree list` does not.
    expect((await runner.run(["worktree", "add", "x"], fake.directory)).split("\n")[0]).toBe(
      "unset",
    );
    expect((await runner.run(["worktree", "list"], fake.directory)).split("\n")[0]).toBe("0");
  });

  test("a missing git is GitNotFound, not a per-invocation failure", async () => {
    await using directory = await temporaryDirectory("git-absent");
    const runner = gitRunner({ environment: { PATH: "/nonexistent" } });

    const thrown = await runner.run(["--version"], directory.path as AbsolutePath).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(GitNotFound);
  });

  test("a non-zero exit is a GitFailure carrying the subcommand and stderr", async () => {
    await using fixture = await gitFixture("git-failure");
    const runner = gitRunner();
    const repository = fixture.path as AbsolutePath;

    // `worktree add` with no path: git refuses with usage on stderr.
    const failure = await runner.run(["worktree", "add"], repository).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GitFailure);
    if (!(failure instanceof GitFailure)) throw new Error("expected a GitFailure");
    expect(failure.subcommand).toBe("worktree add");
    expect(failure.exitCode).not.toBe(0);
    expect(failure.standardError).toMatch(/usage|fatal/);

    // The same command through `probe` is an answer, not an exception.
    const outcome = await runner.probe(["worktree", "add"], repository);
    expect(outcome.succeeded).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
  });

  test("-C scopes to the directory, not the process cwd", async () => {
    await using fixture = await gitFixture("git-scope");

    const toplevel = await gitRunner().run(
      ["rev-parse", "--show-toplevel"],
      fixture.path as AbsolutePath,
    );

    expect(toplevel.trim()).toBe(fixture.path);
  });
});
