/**
 * `@janela/support/process` — the one subprocess runner. **Daemon-only.**
 *
 * `@janela/git` and `@janela/forge` are peers and must never import each other,
 * so the plumbing they share lives here. That rule is from AGENTS.md and it is
 * enforced: `scripts/layers.ts` gates this subpath to the daemon side, and gates
 * `node:child_process` to this package.
 *
 * ## The one rule
 *
 * **Arguments are always an array. There is no shell, so there is no quoting and
 * no injection.** A caller who genuinely wants a shell writes
 * `["zsh", "-lc", "…"]` and has chosen that explicitly. This is the same rule
 * `LaunchProfile.command` and `AutomationCommand.command` follow, for the same
 * reason. See docs/decisions/0007-git-integration.md.
 */

export interface ProcessRequest {
  /** Executable. Resolved by the caller; this layer does not search `PATH`. */
  readonly executable: string;
  /** Arguments, *excluding* `argv[0]`. */
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  /**
   * The complete environment for the child, not merged with our own. The caller
   * decides exactly what the child sees.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Kills the child after this many milliseconds. Absent means no limit, which
   * is only correct for something a user is watching.
   */
  readonly timeoutMs?: number;
}

export interface ProcessOutcome {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
  /** True when the timeout killed it, which is a different failure from a non-zero exit. */
  readonly timedOut: boolean;
}

/**
 * Runs a process and collects its output.
 *
 * A protocol rather than a function so tests can substitute a recording fake —
 * which is what automation, attention-policy and forge tests do, because the
 * logic under test is the decision, not the subprocess. Git is *not* faked: see
 * docs/testing.md.
 */
export interface ProcessRunning {
  /** Runs to completion and collects stdout/stderr. Never throws on a non-zero exit. */
  run(request: ProcessRequest): Promise<ProcessOutcome>;

  /**
   * Whether an executable exists on a given `PATH`.
   *
   * Used to decide whether a launch profile is offered at all: if `claude` is not
   * on the user's `PATH` the profile is hidden rather than shown broken, and a
   * missing `gh` is silence rather than an error banner.
   */
  which(executable: string, path: string): Promise<string | undefined>;
}

/** The production runner. */
export function processRunner(): ProcessRunning {
  throw new Error(`not implemented: processRunner`);
}
