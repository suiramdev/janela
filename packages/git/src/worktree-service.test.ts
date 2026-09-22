import { describe, expect, test } from "bun:test";
import { rm, stat, writeFile } from "node:fs/promises";

import type { AbsolutePath } from "@janela/core";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import { GitFailure, gitRunner } from "./git-runner.ts";
import {
  isTriviallySafe,
  removalObstacleLabel,
  removalObstacles,
  worktreeService,
  type WorktreeRemovalSafety,
  type WorktreeServing,
} from "./worktree-service.ts";

const NOTHING_LOST: WorktreeRemovalSafety = {
  hasUncommittedChanges: false,
  hasUntrackedFiles: false,
  hasUnpushedCommits: false,
  isLocked: false,
  hasRunningSessions: false,
};

async function setup(label: string): Promise<
  AsyncDisposable & {
    readonly repository: AbsolutePath;
    readonly service: WorktreeServing;
    readonly scratch: (...components: string[]) => AbsolutePath;
    readonly gitIn: (directory: string, ...args: string[]) => Promise<string>;
    readonly git: (...args: string[]) => Promise<string>;
    readonly commit: (file: string, contents: string, message: string | undefined) => Promise<void>;
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

    const safety = await world.service.removalSafety(entry);

    expect(safety).toEqual(NOTHING_LOST);
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

    expect(created.isDetached).toBe(true);
    expect(created.branch).toBeUndefined();
    expect(created.head).toBe((await world.git("rev-parse", "HEAD")).trim());
  });

  test("a branch another worktree holds needs force, and git says so without it", async () => {
    await using world = await setup("wt-add-shared");

    await world.git("branch", "feat/shared");
    await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("shared-first"),
      branch: "feat/shared",
    });

    await expect(
      world.service.createWorktree({
        repository: world.repository,
        directory: world.scratch("shared-second"),
        branch: "feat/shared",
      }),
    ).rejects.toBeInstanceOf(GitFailure);

    const forced = await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("shared-second"),
      branch: "feat/shared",
      force: true,
    });

    expect(forced.branch).toBe("feat/shared");

    const holders = (await world.service.worktrees(world.repository)).filter(
      (entry) => entry.branch === "feat/shared",
    );

    expect(holders).toHaveLength(2);
  });
});

describe("removalObstacles", () => {
  test("names every reason removal would lose work, in the order the dialog reads them", () => {
    const everything: WorktreeRemovalSafety = {
      hasUncommittedChanges: true,
      hasUntrackedFiles: true,
      hasUnpushedCommits: true,
      isLocked: true,
      hasRunningSessions: true,
    };

    expect(removalObstacles(everything).map(removalObstacleLabel)).toEqual([
      "uncommittedChanges",
      "untrackedFiles",
      "unpushedCommits",
      "locked",
      "runningSessions",
    ]);
  });

  test("nothing to lose is an empty list, which is what trivially safe means", () => {
    expect(removalObstacles(NOTHING_LOST)).toEqual([]);
    expect(isTriviallySafe(NOTHING_LOST)).toBe(true);
    expect(isTriviallySafe({ ...NOTHING_LOST, hasRunningSessions: true })).toBe(false);
  });
});

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

    expect(safety).toEqual(NOTHING_LOST);
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
    await world.commit("??notes.txt", "notes\n", undefined);

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

    expect((await world.service.removalSafety(onBranch)).hasUnpushedCommits).toBe(true);

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

describe("branches", () => {
  test("lists every local branch, and no remote-tracking or tag ref", async () => {
    await using world = await setup("wt-branches");

    await world.git("branch", "feat/a");
    await world.git("branch", "feat/b");
    await world.git("tag", "v1");
    await withOrigin(world);

    const listed = await world.service.branches(world.repository);

    expect(listed).toEqual(["feat/a", "feat/b", "main"]);
  });

  test("a detached HEAD does not hide the branches", async () => {
    await using world = await setup("wt-branches-detached");

    await world.git("branch", "feat/c");
    await world.git("checkout", "-q", "--detach", "HEAD");

    expect(await world.service.branches(world.repository)).toEqual(["feat/c", "main"]);
  });
});

describe("checkoutBranch", () => {
  test("moves the repository's own checkout onto an existing branch", async () => {
    await using world = await setup("wt-checkout");

    await world.git("branch", "feat/target");
    await world.service.checkoutBranch(world.repository, "feat/target");

    expect((await world.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("feat/target");
  });

  test("checking out the branch already checked out is a no-op that succeeds", async () => {
    await using world = await setup("wt-checkout-same");

    await world.service.checkoutBranch(world.repository, "main");

    expect((await world.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
  });

  test("a branch that does not exist is git's failure, not an invented branch", async () => {
    await using world = await setup("wt-checkout-missing");

    await expect(
      world.service.checkoutBranch(world.repository, "feat/absent"),
    ).rejects.toBeInstanceOf(GitFailure);

    expect(await world.service.branches(world.repository)).toEqual(["main"]);
    expect((await world.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
  });

  test("a branch checked out in a linked worktree is refused rather than stolen", async () => {
    await using world = await setup("wt-checkout-elsewhere");

    await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("held"),
      branch: "feat/held",
    });

    await expect(
      world.service.checkoutBranch(world.repository, "feat/held"),
    ).rejects.toBeInstanceOf(GitFailure);

    expect((await world.git("rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
  });
});
