import type { AbsolutePath } from "@janela/core";

import type { GitRunning } from "./git-runner.ts";

/**
 * `.worktreeinclude` — the repo-declared list of ignored files to carry into a
 * new worktree: `.env`, `node_modules`, build caches.
 *
 * Two decisions from docs/decisions/0013-worktreeinclude.md are load-bearing here,
 * and both are about not writing code we would get wrong:
 *
 * 1. **git matches the patterns.** The honest implementation of "which ignored
 *    files match these patterns" is `git ls-files -o -i --exclude-from`, not a
 *    gitignore matcher we wrote. Ours would disagree with git's the first time
 *    someone used a negation.
 * 2. **`clonefile` moves the bytes.** On APFS a clone is metadata-only, which is
 *    what makes copying a 500 MB `node_modules` cost milliseconds instead of
 *    seconds. A non-APFS fallback is allowed to be slow; it is not allowed to be
 *    silent, because a silent fallback is how the budget in docs/performance.md
 *    stops being met without anyone noticing.
 */
export interface WorktreeIncluding {
  /**
   * Resolves the patterns in `<repository>/.worktreeinclude` to actual paths,
   * relative to the repository root.
   *
   * Returns empty when the file does not exist, which is the common case and not
   * an error.
   */
  resolve(repository: AbsolutePath): Promise<readonly string[]>;

  /**
   * Copies the resolved paths into a freshly created worktree.
   *
   * Runs *before* any automation, because scripts depend on their `.env` already
   * being present — the ordering is fixed and documented in
   * docs/domain-model.md § AutomationCommand.
   *
   * @returns The paths actually copied, which is what
   *   `WorktreeBinding.includedPaths` records so the removal dialog can name them
   *   later.
   */
  copy(request: {
    readonly repository: AbsolutePath;
    readonly worktree: AbsolutePath;
    readonly paths: readonly string[];
  }): Promise<CopyReport>;
}

export interface CopyReport {
  readonly copied: readonly string[];
  readonly totalBytes: number;
  /**
   * True when the filesystem did not support cloning and we fell back to a
   * byte-for-byte copy. Logged, and worth surfacing if it ever becomes common.
   */
  readonly usedFallbackCopy: boolean;
}

export function worktreeIncluding(git: GitRunning): WorktreeIncluding {
  void git;
  throw new Error(`not implemented: worktreeIncluding`);
}
