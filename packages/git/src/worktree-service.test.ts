import { describe, expect, test } from "bun:test";
import { rm, stat, writeFile } from "node:fs/promises";

import type { AbsolutePath } from "@janela/core";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import { GitFailure, gitRunner } from "./git-runner.ts";
import { isTriviallySafe, worktreeService, type WorktreeServing } from "./worktree-service.ts";

/**
 * A repository with one commit, a scratch directory to put worktrees in, and the
 * real service over the real git.
 *
 * Git is not faked here on purpose: `git worktree add` either works against a
 * real repository or it does not, and a fake would only prove our assumptions.
 * See docs/testing.md.
 */
async function setup(label: string): Promise<
  AsyncDisposable & {
    readonly repository: AbsolutePath;
    readonly service: WorktreeServing;
    readonly scratch: (...components: string[]) => AbsolutePath;
    /** Runs git inside `directory`, with the fixture's hermetic environment. */
    readonly gitIn: (directory: string, ...args: string[]) => Promise<string>;
    readonly git: (...args: string[]) => Promise<string>;
    readonly commit: (file: string, contents: string, message?: string) => Promise<void>;
  }
> {
  const fixture = await gitFixture(label);
  const scratch = await temporaryDirectory(`${label}-worktrees`);

  return {
    repository: fixture.path as AbsolutePath,
    service: worktreeService(gitRunner()),
    scratch: (...components: string[]) => scratch.join(...components) as AbsolutePath,
    gitIn: (directory: string, ...args: string[]) => fixture.git("-C", directory, ...args),
    git: fixture.git,
    commit: fixture.commit,
    async [Symbol.asyncDispose](): Promise<void> {
      await scratch[Symbol.asyncDispose]();
      await fixture[Symbol.asyncDispose]();
    },
  };
}

describe("worktrees", () => {
  test("lists the main worktree with its branch and head", async () => {
    await using world = await setup("wt-list");

    const listed = await world.service.worktrees(world.repository);

    expect(listed).toHaveLength(1);
    const [main] = listed;
    if (main === undefined) throw new Error("expected the main worktree");
    expect(main.path).toBe(world.repository);
    expect(main.branch).toBe("main");
    expect(main.head).toMatch(/^[0-9a-f]{40}$/);
    expect(main.isBare).toBe(false);
    expect(main.isDetached).toBe(false);
    expect(main.isPrunable).toBe(false);
    expect(main.lockReason).toBeUndefined();
  });

  test("a worktree path containing a newline survives parsing", async () => {
    await using world = await setup("wt-newline");
    const directory = world.scratch("wt\nline");

    await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/newline",
    });

    // A parser that split the porcelain output on newlines would report two
    // worktrees here, neither of them at a real path.
    const listed = await world.service.worktrees(world.repository);
    const created = listed.find((entry) => entry.path === directory);
    expect(created).toBeDefined();
    expect(created?.branch).toBe("feat/newline");
    expect(listed).toHaveLength(2);
  });

  test("a worktree whose directory vanished is prunable, and safe", async () => {
    await using world = await setup("wt-prunable");
    const directory = world.scratch("gone");
    await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/gone",
    });
    await rm(directory, { recursive: true, force: true });

    const entry = (await world.service.worktrees(world.repository)).find(
      (candidate) => candidate.path === directory,
    );
    if (entry === undefined) throw new Error("expected git to still list the worktree");
    expect(entry.isPrunable).toBe(true);

    // Nothing to lose, and nothing to run git against.
    const safety = await world.service.removalSafety(entry);
    expect(safety).toEqual({
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      hasUnpushedCommits: false,
      isLocked: false,
      hasRunningSessions: false,
    });
    expect(isTriviallySafe(safety)).toBe(true);
  });
});

describe("createWorktree", () => {
  test("creates a new branch from HEAD when no start point is given", async () => {
    await using world = await setup("wt-add-branch");
    const directory = world.scratch("feat-a");

    const created = await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/a",
    });

    expect(created.path).toBe(directory);
    expect(created.branch).toBe("feat/a");
    expect(created.head).toBe((await world.git("rev-parse", "HEAD")).trim());
    expect(created.isDetached).toBe(false);
  });

  test("branches from the start point when one is given", async () => {
    await using world = await setup("wt-add-start");
    await world.git("commit", "-q", "--allow-empty", "-m", "second");
    const previous = (await world.git("rev-parse", "HEAD~1")).trim();

    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("feat-b"),
      branch: "feat/b",
      startPoint: "HEAD~1",
    });

    expect(created.head).toBe(previous);
  });

  test("checks out an existing branch instead of failing", async () => {
    await using world = await setup("wt-add-existing");
    await world.git("branch", "feat/c");

    // `worktree add -b feat/c` would exit non-zero: the branch is already there.
    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("feat-c"),
      branch: "feat/c",
    });

    expect(created.branch).toBe("feat/c");
  });

  test("a worktree with no branch is detached, not on an invented one", async () => {
    await using world = await setup("wt-add-detached");
    const directory = world.scratch("detached");

    const created = await world.service.createWorktree({ repository: world.repository, directory });

    // Bare `git worktree add <path>` would create a branch named "detached".
    expect(created.isDetached).toBe(true);
    expect(created.branch).toBeUndefined();
    expect(created.head).toBe((await world.git("rev-parse", "HEAD")).trim());
  });
});

/** Gives the fixture an `origin` it can be up to date with. */
async function withOrigin(world: {
  readonly repository: AbsolutePath;
  readonly scratch: (...components: string[]) => AbsolutePath;
  readonly git: (...args: string[]) => Promise<string>;
}): Promise<void> {
  const origin = world.scratch("origin.git");
  await world.git("clone", "-q", "--bare", world.repository, origin);
  await world.git("remote", "add", "origin", origin);
  await world.git("fetch", "-q", "origin");
  await world.git("branch", "--set-upstream-to=origin/main", "main");
}

describe("removalSafety", () => {
  test("a fresh worktree tracking a pushed branch is trivially safe", async () => {
    await using world = await setup("wt-safe");
    await withOrigin(world);
    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("clean"),
      branch: "feat/clean",
    });
    await world.git("branch", "-u", "origin/main", "feat/clean");

    const safety = await world.service.removalSafety(created);

    expect(safety).toEqual({
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      hasUnpushedCommits: false,
      isLocked: false,
      hasRunningSessions: false,
    });
    expect(isTriviallySafe(safety)).toBe(true);
  });

  test("untracked files and modified files are reported separately", async () => {
    await using world = await setup("wt-dirty");
    await withOrigin(world);
    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("dirty"),
      branch: "feat/dirty",
    });
    await world.git("branch", "-u", "origin/main", "feat/dirty");

    await writeFile(`${created.path}/scratch.txt`, "notes\n", "utf8");
    const untrackedOnly = await world.service.removalSafety(created);
    expect(untrackedOnly.hasUntrackedFiles).toBe(true);
    expect(untrackedOnly.hasUncommittedChanges).toBe(false);
    expect(isTriviallySafe(untrackedOnly)).toBe(false);

    await writeFile(`${created.path}/README.md`, "# changed\n", "utf8");
    await world.gitIn(created.path, "add", "--", "README.md");
    const both = await world.service.removalSafety(created);
    expect(both.hasUncommittedChanges).toBe(true);
    expect(both.hasUntrackedFiles).toBe(true);
  });

  test("a rename's source path is not read as a status entry", async () => {
    await using world = await setup("wt-rename");
    await withOrigin(world);
    // A file whose name begins with the untracked code. `status -z` emits a
    // rename as two tokens — `R  notes.txt` then the bare source `??notes.txt` —
    // and a parser that reads the second one takes "??" for a status.
    await world.commit("??notes.txt", "notes\n");
    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("renamed"),
      branch: "feat/renamed",
    });
    await world.git("branch", "-u", "origin/main", "feat/renamed");

    await world.gitIn(created.path, "mv", "??notes.txt", "notes.txt");

    const safety = await world.service.removalSafety(created);

    expect(safety.hasUncommittedChanges).toBe(true);
    expect(safety.hasUntrackedFiles).toBe(false);
  });

  test("unpushed commits count as work that would be lost", async () => {
    await using world = await setup("wt-unpushed");
    await withOrigin(world);
    const created = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("ahead"),
      branch: "feat/ahead",
    });
    await world.git("branch", "-u", "origin/main", "feat/ahead");
    await world.gitIn(created.path, "commit", "-q", "--allow-empty", "-m", "work");

    const safety = await world.service.removalSafety(created);

    expect(safety.hasUnpushedCommits).toBe(true);
    expect(safety.hasUncommittedChanges).toBe(false);
    expect(safety.hasUntrackedFiles).toBe(false);
  });

  test("with no upstream, commits no remote holds are unpushed", async () => {
    await using world = await setup("wt-no-upstream");
    const onBranch = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("no-upstream"),
      branch: "feat/no-upstream",
    });
    await world.gitIn(onBranch.path, "commit", "-q", "--allow-empty", "-m", "local work");

    // No remote at all: nothing else holds these commits, so removing the
    // worktree's branch would lose them.
    expect((await world.service.removalSafety(onBranch)).hasUnpushedCommits).toBe(true);

    // Detached at `main`: its commits live on a branch that survives removal.
    const detached = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("detached"),
      startPoint: "main",
    });
    expect((await world.service.removalSafety(detached)).hasUnpushedCommits).toBe(false);
  });
});

describe("removeWorktree", () => {
  test("a locked worktree is never trivially safe, and removal refuses it", async () => {
    await using world = await setup("wt-locked");
    const directory = world.scratch("locked");
    await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/locked",
    });
    await world.git("worktree", "lock", "--reason", "busy here", directory);

    const entry = (await world.service.worktrees(world.repository)).find(
      (candidate) => candidate.path === directory,
    );
    expect(entry?.lockReason).toBe("busy here");
    if (entry === undefined) throw new Error("expected the locked worktree");

    const safety = await world.service.removalSafety(entry);
    expect(safety.isLocked).toBe(true);
    expect(isTriviallySafe(safety)).toBe(false);

    // git wants a second `--force` for a locked worktree. We never send it.
    await expect(
      world.service.removeWorktree({
        repository: world.repository,
        directory,
        force: true,
      }),
    ).rejects.toBeInstanceOf(GitFailure);
    expect((await stat(directory)).isDirectory()).toBe(true);
  });

  test("removal takes the directory with it", async () => {
    await using world = await setup("wt-remove");
    const directory = world.scratch("removable");
    await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/removable",
    });

    await world.service.removeWorktree({ repository: world.repository, directory, force: false });

    expect(
      (await world.service.worktrees(world.repository)).some((entry) => entry.path === directory),
    ).toBe(false);
    await expect(stat(directory)).rejects.toThrow();
  });

  test("removal refuses untracked work without force, and takes it with force", async () => {
    await using world = await setup("wt-remove-force");
    const directory = world.scratch("dirty-remove");
    await world.service.createWorktree({
      repository: world.repository,
      directory,
      branch: "feat/dirty-remove",
    });
    await writeFile(`${directory}/scratch.txt`, "notes\n", "utf8");

    await expect(
      world.service.removeWorktree({ repository: world.repository, directory, force: false }),
    ).rejects.toBeInstanceOf(GitFailure);
    expect((await stat(directory)).isDirectory()).toBe(true);

    await world.service.removeWorktree({ repository: world.repository, directory, force: true });
    await expect(stat(directory)).rejects.toThrow();
  });
});
