import type { AbsolutePath } from "@janela/core";
import { UserFacingError } from "@janela/support";

/**
 * Runs `git` as a subprocess and returns its output.
 *
 * ## Why not a git library?
 *
 * The same reason we did not use libgit2 before, and it did not change with the
 * language: every JavaScript git implementation is further from the CLI than
 * libgit2 was, and the CLI is the thing users' repositories are actually
 * configured for — hooks, credential helpers, `includeIf` config, LFS,
 * sparse-checkout and `core.fsmonitor` all work because git itself is running.
 * Shelling out costs a few milliseconds per call and buys correctness. See
 * docs/decisions/0007-git-integration.md.
 *
 * ## Rules
 *
 * - Arguments are always an array. There is no shell, so no quoting, no injection.
 * - Every invocation is scoped with `-C <directory>`; we never `chdir`.
 * - `GIT_OPTIONAL_LOCKS=0` on read-only commands so a background refresh never
 *   fights the user's own `git` for `index.lock`.
 */
export interface GitRunning {
  /**
   * Runs git and returns stdout on success.
   *
   * @throws {GitFailure} when git exits non-zero.
   */
  run(args: readonly string[], directory: AbsolutePath): Promise<string>;

  /**
   * Runs git ignoring the exit status, returning stdout, stderr and the code.
   *
   * Use for commands where a non-zero status is a legitimate answer
   * (`git rev-parse --verify`, `git diff --quiet`).
   */
  probe(args: readonly string[], directory: AbsolutePath): Promise<GitOutcome>;
}

export interface GitOutcome {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
}

export class GitFailure extends UserFacingError {
  readonly subcommand: string;
  readonly exitCode: number;
  /**
   * git's stderr. Logged and shown in a disclosure triangle, never in the
   * headline — see `UserFacingError`.
   */
  readonly standardError: string;

  override readonly summary: string;

  constructor(subcommand: string, exitCode: number, standardError: string) {
    // stderr becomes `reason`, which is shown in a disclosure triangle. An empty
    // stderr becomes nothing at all rather than an empty second sentence.
    super(`git ${subcommand} failed`, standardError === "" ? undefined : { reason: standardError });
    this.summary = `git ${subcommand} failed.`;
    this.subcommand = subcommand;
    this.exitCode = exitCode;
    this.standardError = standardError;
  }
}

/**
 * The production `GitRunning`.
 *
 * Resolves the user's `git` (Homebrew's, usually) rather than hardcoding
 * `/usr/bin/git`, because the system git is older and lacks some worktree flags.
 * Resolved once at startup from the login-shell `PATH`.
 */
export function gitRunner(options?: { readonly executable?: string }): GitRunning {
  void options;
  throw new Error(`not implemented: gitRunner`);
}
