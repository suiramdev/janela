import type { AbsolutePath } from "@janela/core";
import { UserFacingError } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";

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
 * Shelling out costs a few milliseconds per call and buys correctness.
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

export interface GitRunnerOptions {
  /**
   * Absolute path to the git binary. When absent it is resolved once, lazily,
   * with `which` over `environment.PATH`.
   */
  readonly executable?: string;
  /**
   * The complete environment every git child sees, and the `PATH` git is
   * resolved from. The daemon passes the login shell's captured environment so
   * Homebrew's git wins over `/usr/bin/git`; defaults to this process's own.
   */
  readonly environment?: Readonly<Record<string, string>>;
  /** Injected for tests; defaults to `processRunner()`. */
  readonly processes?: ProcessRunning;
  /** Per-invocation limit, because git in a daemon is never watched. */
  readonly timeoutMs?: number;
}

/**
 * git is expected to be present. It is not something we can install for the
 * user, and it is not something to report per-invocation.
 */
export class GitNotFound extends UserFacingError {
  override readonly summary = "git was not found.";

  constructor() {
    super("git not found on PATH", {
      recoverySuggestion: "Install git (for example with Homebrew) and restart Janela.",
    });
  }
}

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * Commands that only read. For these the child gets `GIT_OPTIONAL_LOCKS=0`, so a
 * background refresh never takes `index.lock` out from under the user's own git.
 *
 * Matched on the leading tokens rather than "the first token", because
 * `worktree list` reads and `worktree add` does not.
 */
const READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  ["status"],
  ["log"],
  ["diff"],
  ["rev-parse"],
  ["ls-files"],
  ["show"],
  ["for-each-ref"],
  ["worktree", "list"],
];

function isReadOnly(args: readonly string[]): boolean {
  return READ_ONLY_COMMANDS.some((prefix) => prefix.every((token, index) => args[index] === token));
}

/**
 * What to call this invocation when it fails. `GitFailure.subcommand` reaches a
 * person, so it is the command the user would recognise ("worktree add"), not
 * the whole argv — which would carry paths and branch names into a headline.
 */
function subcommandOf(args: readonly string[]): string {
  const index = args.findIndex((token) => !token.startsWith("-"));
  const first = index === -1 ? undefined : args[index];
  if (first === undefined) return "git";
  if (first !== "worktree") return first;
  const second = args[index + 1];
  return second === undefined ? first : `${first} ${second}`;
}

/**
 * The production `GitRunning`.
 *
 * Resolves the user's `git` (Homebrew's, usually) rather than hardcoding
 * `/usr/bin/git`, because the system git is older and lacks some worktree flags.
 * Resolution happens once, on first use, and is remembered — including its
 * failure, so a machine without git does not pay for a `PATH` walk per call.
 */
export function gitRunner(options?: GitRunnerOptions): GitRunning {
  const processes = options?.processes ?? processRunner();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const environment: Readonly<Record<string, string>> =
    options?.environment ??
    Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );

  const configured = options?.executable;
  let resolving: Promise<string> | undefined;
  const executable = (): Promise<string> => {
    resolving ??= (async () => {
      if (configured !== undefined) return configured;
      const found = await processes.which("git", environment["PATH"] ?? "/usr/bin:/bin");
      if (found === undefined) throw new GitNotFound();
      return found;
    })();
    return resolving;
  };

  const probe = async (args: readonly string[], directory: AbsolutePath): Promise<GitOutcome> => {
    const outcome = await processes.run({
      executable: await executable(),
      // `-C` on every invocation; we never `chdir`, because the daemon runs one
      // process for every repository the user has open.
      arguments: ["-C", directory, ...args],
      workingDirectory: directory,
      environment: isReadOnly(args) ? { ...environment, GIT_OPTIONAL_LOCKS: "0" } : environment,
      timeoutMs,
    });
    // `timedOut` is dropped deliberately: a killed git is a failed git, and the
    // caller's recovery is the same either way.
    return {
      standardOutput: outcome.standardOutput,
      standardError: outcome.standardError,
      exitCode: outcome.exitCode,
      succeeded: outcome.succeeded,
    };
  };

  return {
    async run(args: readonly string[], directory: AbsolutePath): Promise<string> {
      const outcome = await probe(args, directory);
      if (!outcome.succeeded) {
        throw new GitFailure(subcommandOf(args), outcome.exitCode, outcome.standardError.trimEnd());
      }
      return outcome.standardOutput;
    },
    probe,
  };
}
