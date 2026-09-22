import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";

import type { AbsolutePath } from "@janela/core";
import { isUserFacing } from "@janela/support";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import {
  GitError,
  GitFailure,
  gitErrorLabel,
  GitNotFound,
  gitRunner,
  GitUnrunnable,
} from "./git-runner.ts";

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

describe("GitError", () => {
  test("a reason is named by its tag, and the tag is all a log field gets", () => {
    const error = new GitError({ reason: new GitUnrunnable({ cause: new Error("spawn failed") }) });

    expect(gitErrorLabel(error)).toBe("unrunnable");
    expect(error.message).toBe("git error: unrunnable");
    expect(isUserFacing(error)).toBe(false);
  });
});

describe("gitRunner", () => {
  test("git is resolved from the given PATH, not a hardcoded location", async () => {
    await using fake = await fakeGit("git-path");

    const output = await gitRunner({ environment: { PATH: fake.directory } }).run(
      ["--version"],
      fake.directory,
    );

    expect(output.trimEnd().split("\n")).toEqual(["unset", "-C", fake.directory, "--version"]);
  });

  test("every invocation is scoped with -C and arguments are passed as an array", async () => {
    await using fake = await fakeGit("git-argv");

    const output = await gitRunner({ environment: { PATH: fake.directory } }).run(
      ["status", "a b"],
      fake.directory,
    );

    expect(output.trimEnd().split("\n")).toEqual(["0", "-C", fake.directory, "status", "a b"]);
  });

  test("write commands do not set GIT_OPTIONAL_LOCKS", async () => {
    await using fake = await fakeGit("git-locks");
    const runner = gitRunner({ environment: { PATH: fake.directory } });

    expect((await runner.run(["worktree", "add", "x"], fake.directory)).split("\n")[0]).toBe(
      "unset",
    );

    expect((await runner.run(["worktree", "list"], fake.directory)).split("\n")[0]).toBe("0");
  });

  test("a missing git is GitNotFound, not a per-invocation failure", async () => {
    await using directory = await temporaryDirectory("git-absent");
    const runner = gitRunner({ environment: { PATH: "/nonexistent" } });

    await expect(runner.run(["--version"], directory.path as AbsolutePath)).rejects.toBeInstanceOf(
      GitNotFound,
    );
  });

  test("a git that cannot be executed is a typed reason, and names no path", async () => {
    await using fake = await fakeGit("git-unrunnable");
    const executable = `${fake.directory}/git`;

    await chmod(executable, 0o000);

    const thrown = await gitRunner({ executable })
      .probe(["status"], fake.directory)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    expect(thrown).toBeInstanceOf(GitError);

    if (!(thrown instanceof GitError)) throw new Error("expected a GitError");

    expect(gitErrorLabel(thrown)).toBe("unrunnable");
    expect(thrown.message).not.toContain(executable);
  });

  test("a non-zero exit is a GitFailure carrying the subcommand and stderr", async () => {
    await using fixture = await gitFixture("git-failure");
    const runner = gitRunner();
    const repository = fixture.path as AbsolutePath;

    const failure = await runner.run(["worktree", "add"], repository).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(GitFailure);

    if (!(failure instanceof GitFailure)) throw new Error("expected a GitFailure");

    expect(failure.subcommand).toBe("worktree add");
    expect(failure.exitCode).not.toBe(0);
    expect(failure.standardError).toMatch(/usage|fatal/);
  });

  test("probe reports a non-zero exit as an answer, not an exception", async () => {
    await using fixture = await gitFixture("git-probe");

    const outcome = await gitRunner().probe(["worktree", "add"], fixture.path as AbsolutePath);

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
