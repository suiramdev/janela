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
 * reason.
 */

import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * The production runner.
 *
 * ## Output is not capped here
 *
 * stdout and stderr are collected whole. That is safe for what the daemon runs
 * through this — git porcelain output bounded by repository size, `gh`/`glab`
 * JSON, `log -n 1` — and it is the caller's job to keep it that way. Terminal
 * traffic never comes through here; it goes through `@janela/pty`, which has a
 * bounded scrollback for exactly this reason (AGENTS.md § no unbounded buffers).
 *
 * A failure to *start* — no such executable, not executable — rejects rather
 * than returning an outcome: there was no process, so there is no exit status to
 * report. A non-zero exit, and a timeout kill, are outcomes.
 */
export function processRunner(): ProcessRunning {
  return {
    run(request: ProcessRequest): Promise<ProcessOutcome> {
      return new Promise<ProcessOutcome>((resolve, reject) => {
        const child = spawn(request.executable, [...request.arguments], {
          cwd: request.workingDirectory,
          // Absent means an empty environment, not an inherited one: the
          // interface promises the caller decides exactly what the child sees.
          env: request.environment ?? {},
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });

        const standardOutput: Buffer[] = [];
        const standardError: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => standardOutput.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => standardError.push(chunk));

        let timedOut = false;
        const timer =
          request.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                // SIGKILL rather than SIGTERM: the point of the limit is that
                // nobody is watching, so a process ignoring SIGTERM would hang
                // the caller forever.
                child.kill("SIGKILL");
              }, request.timeoutMs);

        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });

        // `close`, not `exit`: `exit` can fire before the pipes are drained, and
        // then we would decode a truncated stdout.
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({
            standardOutput: Buffer.concat(standardOutput).toString("utf8"),
            standardError: Buffer.concat(standardError).toString("utf8"),
            exitCode: code ?? -1,
            succeeded: code === 0,
            timedOut,
          });
        });
      });
    },

    async which(executable: string, path: string): Promise<string | undefined> {
      // A path-ish name is not searched for: it is checked where it points.
      if (executable.includes("/")) {
        return (await isRunnable(executable)) ? executable : undefined;
      }
      for (const directory of path.split(":")) {
        if (directory === "") continue;
        const candidate = join(directory, executable);
        // `PATH` is ordered and the first hit wins, so the search is sequential
        // on purpose: statting every entry at once would also touch directories
        // *after* the match, and a `PATH` can name a slow network mount.
        // oxlint-disable-next-line no-await-in-loop
        if (await isRunnable(candidate)) return candidate;
      }
      return undefined;
    },
  };
}

/**
 * Whether `candidate` is a regular file we may execute.
 *
 * `process.env.PATH` is deliberately never consulted: the caller's `path`
 * argument is the whole search space, because the daemon's own environment is
 * not the user's login-shell environment.
 */
async function isRunnable(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
