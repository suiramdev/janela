import type { AbsolutePath } from "@janela/core";

import type { GitRunning } from "./git-runner.ts";

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
 * Everything Janela does with worktrees. Note how small it is: create, list,
 * remove, and check whether removal is safe. Anything more elaborate belongs in
 * the user's own git, not in this app.
 */
export interface WorktreeServing {
  /** `git worktree list --porcelain -z` for a repository. */
  worktrees(repository: AbsolutePath): Promise<readonly GitWorktree[]>;

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
  void safety;
  throw new Error(`not implemented: isTriviallySafe`);
}

/**
 * The production `WorktreeServing`, implemented on top of `GitRunning`.
 *
 * Every method is a thin translation between Janela's vocabulary and git's
 * porcelain output. There is no caching and no reconciliation: git is the source
 * of truth, and we re-read rather than try to stay in sync with it.
 */
export function worktreeService(git: GitRunning): WorktreeServing {
  void git;
  throw new Error(`not implemented: worktreeService`);
}

// The four seams below were `TODO:` comments on the previous `WorktreeService`
// methods. They stay attached to the same operations.

// TODO: worktrees() — `git worktree list --porcelain -z` and parse the
// NUL-delimited records. Use -z because worktree paths can contain newlines.

// TODO: createWorktree() — `git worktree add [-b <branch>] <path> [<start-point>]`,
// then re-read the list so the returned value is git's view rather than ours.

// TODO: removalSafety() — `git status --porcelain`, `git log @{upstream}..HEAD`,
// plus the lock state already carried on `worktree`. `hasRunningSessions` is not
// git's answer: it is filled in by @janela/session, which is the only place that
// knows what is live.

// TODO: removeWorktree() — `git worktree remove [--force] <path>`.
