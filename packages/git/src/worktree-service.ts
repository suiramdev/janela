import { realpath, rm, stat } from "node:fs/promises";

import type { AbsolutePath } from "@janela/core";

import { GitFailure, type GitRunning } from "./git-runner.ts";

/** One entry from `git worktree list --porcelain`. */
export interface GitWorktree {
  readonly path: AbsolutePath;
  readonly head?: string;
  readonly branch?: string;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  /**
   * Set when another process holds the worktree (`git worktree lock`). We must
   * never remove a locked worktree, and the reason is worth showing the user.
   */
  readonly lockReason?: string;
  /** git considers the directory gone. Offer to prune rather than acting alone. */
  readonly isPrunable: boolean;
}

/**
 * Everything Janela does with git. Note how small it is: list branches and
 * worktrees, create a worktree, check out a branch, remove a worktree, and
 * check whether removal is safe. Anything more elaborate belongs in the user's
 * own git, not in this app.
 *
 * The two branch operations are here rather than behind a `GitRunning` the brain
 * holds, because this package's rule is that a raw git command string never
 * leaves it — and because "which branch, and where" is one question the client
 * asks, answered by one seam.
 */
export interface WorktreeServing {
  /** `git worktree list --porcelain -z` for a repository. */
  worktrees(repository: AbsolutePath): Promise<readonly GitWorktree[]>;

  /**
   * Local branch names, in git's order.
   *
   * Short names — what the user typed, and what `createWorktree` and
   * `checkoutBranch` take. `refs/heads` only: a remote-tracking ref is not
   * something the user can check out, and offering one would produce a detached
   * HEAD they did not ask for.
   */
  branches(repository: AbsolutePath): Promise<readonly string[]>;

  /**
   * `git checkout <branch>` in the repository's own directory.
   *
   * Never `-b`: a branch that does not exist is git's error to report, because
   * creating the name the user typed answers a different question. A branch
   * already checked out here is a no-op that succeeds; one checked out in a
   * linked worktree is refused by git, and that refusal is the answer — the
   * user wanted the "adopt" or "new worktree" choice instead.
   *
   * @throws {GitFailure} with git's own reason, which is more useful than
   *   anything we could add: uncommitted changes that would be overwritten,
   *   a branch held by another worktree, or no such branch.
   */
  checkoutBranch(repository: AbsolutePath, branch: string): Promise<void>;

  /**
   * Creates a worktree. `branch` is created if it does not exist, checked out if
   * it does. When `branch` is absent the worktree is detached at `startPoint`.
   *
   * @param repository The repository's main worktree directory.
   * @param directory Where to place it. Janela's default is a sibling
   *   `.worktrees/<slug>` directory inside the repository's parent, which keeps
   *   `~/` tidy and keeps relative paths short. Users can override per creation.
   * @param branch Branch to check out or create; absent for a detached worktree.
   * @param startPoint Commit-ish to branch from. Defaults to `HEAD` when absent.
   * @returns The worktree as git reports it after creation.
   * @throws {GitFailure} when git refuses, most commonly because the branch is
   *   already checked out in another worktree.
   */
  createWorktree(request: {
    readonly repository: AbsolutePath;
    readonly directory: AbsolutePath;
    readonly branch?: string;
    readonly startPoint?: string;
  }): Promise<GitWorktree>;

  /**
   * Whether removing this worktree would lose work. Checked *before* we offer a
   * destructive button, never after.
   */
  removalSafety(worktree: GitWorktree): Promise<WorktreeRemovalSafety>;

  /** `git worktree remove`, plus deleting the directory when git leaves it behind. */
  removeWorktree(request: {
    readonly directory: AbsolutePath;
    readonly repository: AbsolutePath;
    readonly force: boolean;
  }): Promise<void>;
}

/**
 * The result of asking "is it safe to delete this worktree?".
 *
 * Modelled as an explicit list of reasons rather than a bool so the confirmation
 * dialog can say exactly what will be lost. "Are you sure?" is not a real warning.
 */
export interface WorktreeRemovalSafety {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly isLocked: boolean;
  readonly hasRunningSessions: boolean;
}

export function isTriviallySafe(safety: WorktreeRemovalSafety): boolean {
  return (
    !safety.hasUncommittedChanges &&
    !safety.hasUntrackedFiles &&
    !safety.hasUnpushedCommits &&
    !safety.isLocked &&
    !safety.hasRunningSessions
  );
}

/**
 * Parses `git worktree list --porcelain -z`.
 *
 * `-z` and not plain `--porcelain`, because a worktree path may contain a
 * newline and a line-splitting parser would then invent worktrees. Records are
 * separated by two NULs, attributes within a record by one.
 *
 * Unknown attributes are ignored: the porcelain format is documented as
 * append-only, so a newer git adding a line must not break an older reader.
 */
function parseWorktreeList(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];

  for (const record of output.split("\0\0")) {
    if (record === "") continue;

    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let lockReason: string | undefined;
    let isBare = false;
    let isDetached = false;
    let isPrunable = false;

    for (const line of record.split("\0")) {
      if (line === "") continue;
      const separator = line.indexOf(" ");
      const attribute = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? undefined : line.slice(separator + 1);

      switch (attribute) {
        case "worktree":
          path = value;
          break;
        case "HEAD":
          head = value;
          break;
        case "branch":
          // The short name: what the user typed, and what `createWorktree`
          // takes. This is the one place that decides it.
          branch = value?.replace(/^refs\/heads\//, "");
          break;
        case "detached":
          isDetached = true;
          break;
        case "bare":
          isBare = true;
          break;
        case "locked":
          // A lock with no reason is still a lock, so the test for one is
          // `lockReason !== undefined` and never its emptiness.
          lockReason = value ?? "";
          break;
        case "prunable":
          isPrunable = true;
          break;
        default:
          break;
      }
    }

    if (path === undefined) continue;
    worktrees.push({
      // git prints absolute, canonical paths; there is nothing left to resolve.
      path: path as AbsolutePath,
      ...(head === undefined ? {} : { head }),
      ...(branch === undefined ? {} : { branch }),
      ...(lockReason === undefined ? {} : { lockReason }),
      isBare,
      isDetached,
      isPrunable,
    });
  }

  return worktrees;
}

/**
 * Parses `git status --porcelain=v1 -z` into the two answers we need.
 *
 * The subtlety `-z` introduces: a rename or copy entry is *two* NUL-terminated
 * tokens, `XY <new>` followed by the bare original path. Reading that second
 * token as an entry of its own would take its first two characters for a status
 * code and report nonsense.
 */
function parseStatus(output: string): { modified: boolean; untracked: boolean } {
  const tokens = output.split("\0");
  let modified = false;
  let untracked = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry === undefined || entry === "") continue;

    const code = entry.slice(0, 2);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      index += 1; // the rename/copy source, not an entry
    }

    if (code === "??") untracked = true;
    // `!!` is an ignored file, which only appears with --ignored and is not work.
    else if (code !== "!!") modified = true;
  }

  return { modified, untracked };
}

/**
 * The production `WorktreeServing`, implemented on top of `GitRunning`.
 *
 * Every method is a thin translation between Janela's vocabulary and git's
 * porcelain output. There is no caching and no reconciliation: git is the source
 * of truth, and we re-read rather than try to stay in sync with it.
 */
export function worktreeService(git: GitRunning): WorktreeServing {
  const worktrees = async (repository: AbsolutePath): Promise<readonly GitWorktree[]> =>
    parseWorktreeList(await git.run(["worktree", "list", "--porcelain", "-z"], repository));

  return {
    worktrees,

    async branches(repository: AbsolutePath): Promise<readonly string[]> {
      // `%(refname:short)` rather than trimming `refs/heads/` ourselves, and
      // `refs/heads` rather than `--branches`, so nothing remote-tracking or
      // tag-shaped can arrive. Newlines are impossible in a ref name, so
      // line-splitting is safe here in a way it is not for worktree paths.
      const output = await git.run(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repository,
      );
      return output.split("\n").filter((line) => line !== "");
    },

    async checkoutBranch(repository: AbsolutePath, branch: string): Promise<void> {
      // Never `-b`, and no pathspec: `checkout <branch>` is the whole command,
      // and git's refusal for a name that does not exist is the answer we want.
      // git itself rejects a ref name beginning with `-`, so there is nothing
      // for an option terminator to protect against.
      await git.run(["checkout", branch], repository);
    },

    async createWorktree({ repository, directory, branch, startPoint }): Promise<GitWorktree> {
      const start = startPoint === undefined ? [] : [startPoint];

      if (branch === undefined) {
        // `--detach` is not optional: a bare `worktree add <path>` invents a
        // branch named after the directory, which is not what "no branch" means.
        await git.run(["worktree", "add", "--detach", directory, ...start], repository);
      } else {
        const existing = await git.probe(
          ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
          repository,
        );
        if (existing.succeeded) {
          // Checked out, not created: `add -b <existing>` exits non-zero, and the
          // contract says an existing branch is checked out.
          await git.run(["worktree", "add", directory, branch], repository);
        } else {
          await git.run(["worktree", "add", "-b", branch, directory, ...start], repository);
        }
      }

      // Re-read rather than construct: the returned value is git's view, which
      // is the only one that stays true. `realpath` because git canonicalises
      // the path it lists (on macOS `/var/…` becomes `/private/var/…`).
      const created = await realpath(directory);
      const listed = (await worktrees(repository)).find((entry) => entry.path === created);
      if (listed === undefined) {
        // An invariant violation rather than a git error, reported as a git
        // failure so it travels the caller's existing error path.
        throw new GitFailure("worktree list", 0, `git did not list a worktree at ${directory}`);
      }
      return listed;
    },

    /**
     * `hasRunningSessions` is always `false` here: git cannot know what is live.
     * `@janela/session` fills it in, and it is the only layer that can.
     */
    async removalSafety(worktree: GitWorktree): Promise<WorktreeRemovalSafety> {
      const isLocked = worktree.lockReason !== undefined;

      if (worktree.isPrunable) {
        // The directory is gone, so there is nothing to lose and nothing to run
        // git against — `status` in a missing directory only fails.
        return {
          hasUncommittedChanges: false,
          hasUntrackedFiles: false,
          hasUnpushedCommits: false,
          isLocked,
          hasRunningSessions: false,
        };
      }

      const status = parseStatus(await git.run(["status", "--porcelain=v1", "-z"], worktree.path));

      // With an upstream, "unpushed" is exactly what the upstream lacks.
      const ahead = await git.probe(
        ["log", "--format=%H", "-n", "1", "@{upstream}..HEAD"],
        worktree.path,
      );
      let hasUnpushedCommits: boolean;
      if (ahead.succeeded) {
        hasUnpushedCommits = ahead.standardOutput.trim() !== "";
      } else {
        // No upstream configured (git exits 128). Then the honest answer is
        // "commits no remote has", and for a detached HEAD also "commits no
        // local branch has" — those survive the worktree's removal. A
        // repository with no remotes therefore reports its commits as unpushed,
        // which is true: nothing else holds them.
        const unreachable = await git.run(
          [
            "log",
            "--format=%H",
            "-n",
            "1",
            "HEAD",
            "--not",
            "--remotes",
            ...(worktree.isDetached ? ["--branches"] : []),
          ],
          worktree.path,
        );
        hasUnpushedCommits = unreachable.trim() !== "";
      }

      return {
        hasUncommittedChanges: status.modified,
        hasUntrackedFiles: status.untracked,
        hasUnpushedCommits,
        isLocked,
        hasRunningSessions: false,
      };
    },

    async removeWorktree({ directory, repository, force }): Promise<void> {
      // A locked worktree fails here, and that is the point: git demands a second
      // `--force` for one, and we never send it. Unlocking is the user's call.
      await git.run(["worktree", "remove", ...(force ? ["--force"] : []), directory], repository);

      // git leaves the directory behind in some cases (a submodule, an unmerged
      // file it declined to delete). Removing it is what the user asked for.
      try {
        await stat(directory);
      } catch {
        return; // already gone, which is the normal case
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
