import { userInfo } from "node:os";
import { basename } from "node:path";

import type { AutomationEvent, Session, TerminalID } from "@janela/core";
import { worktreeOf } from "@janela/core";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";

import { silentLogger } from "./silent-logger.ts";

/**
 * Resolves the environment a terminal child should be started with.
 *
 * ## The problem this solves
 *
 * A GUI app launched from Finder inherits `launchd`'s environment, not the user's
 * shell environment. `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. Every tool the user
 * installed with Homebrew, mise, nvm, or asdf is missing. This is the single most
 * common way a GUI terminal app feels broken, and the reason "claude: command not
 * found" gets reported as a bug in the IDE.
 *
 * It is *not* fixed by the daemon being a separate process — `janelad` is started
 * by launchd too, and inherits exactly the same impoverished environment.
 *
 * ## The fix
 *
 * Start a login shell as the terminal's process, with `argv[0]` prefixed by `-`,
 * and let the user's own dotfiles build the environment. We never reimplement their
 * shell configuration and we never parse their `.zshrc`.
 *
 * For the cases where we need the environment *ourselves* — checking whether
 * `claude` exists before offering the profile — we run the login shell once at
 * daemon startup and cache the result.
 */
export interface ShellEnvironment {
  /**
   * The user's login shell, from `getpwuid`, falling back to `$SHELL` and then
   * `/bin/zsh`. Never hardcoded.
   */
  readonly loginShell: string;

  /** Environment captured from a single login-shell invocation at startup. */
  readonly resolved: Readonly<Record<string, string>>;

  /**
   * The argument vector for a login shell.
   *
   * The leading `-` is not cosmetic: `zsh` checks `argv[0][0] === '-'` to decide
   * whether to source `.zprofile`.
   */
  loginShellArguments(): readonly string[];
}

export interface ShellEnvironmentOptions {
  /**
   * The daemon's own environment: the source of `$SHELL`, the environment the
   * capture runs with, and the fallback when the capture fails.
   */
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to `processRunner()`. */
  readonly processes?: ProcessRunning;
  /** Where shapes go: a shell name, a count, an exit status. Absent means silent. */
  readonly log?: Logger;
  /** Bound for both the shell resolution probe and the capture. */
  readonly timeoutMs?: number;
  /**
   * The passwd-ish account facts. Production passes nothing and gets
   * `os.userInfo()`; a test passes what a runtime would report, including the
   * `"unknown"` Bun answers with.
   */
  readonly account?: () => AccountInformation | undefined;
}

/** What `os.userInfo()` tells us that matters here. */
export interface AccountInformation {
  readonly shell?: string;
  readonly username?: string;
}

/**
 * The capture runs the user's whole shell configuration, which on a bad day means
 * an `nvm` that talks to the network. Ten seconds is generous for a login shell
 * and short enough that a daemon start does not look hung.
 */
export const SHELL_ENVIRONMENT_TIMEOUT_MS = 10_000;

/** The last resort, and only that: macOS's own default shell. */
export const DEFAULT_LOGIN_SHELL = "/bin/zsh";

/**
 * Printed before the environment so a dotfile that greets the user (`fortune`, a
 * version manager's banner) cannot be mistaken for a variable. `env -0` because a
 * value may contain a newline, and the marker is NUL-delimited for the same
 * reason. The flags are separate rather than `-ilc`: fish's option parser rejects
 * the bundled form.
 */
const CAPTURE_SCRIPT = "printf '\\0JANELA_ENVIRONMENT\\0'; /usr/bin/env -0";
const CAPTURE_MARKER = "\0JANELA_ENVIRONMENT\0";

/** POSIX-shaped names only. A shell function exported by bash is not a variable. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Facts about the capture process rather than about the user: `_` is the last
 * command the shell ran, `SHLVL` counts our own invocation, and the two directory
 * variables describe where we chose to run it.
 */
const CAPTURE_ARTEFACTS: Readonly<Record<string, true>> = {
  _: true,
  SHLVL: true,
  PWD: true,
  OLDPWD: true,
};

/** Resolves the environment once. Called during daemon startup, off the critical path. */
export async function resolveShellEnvironment(
  options?: ShellEnvironmentOptions,
): Promise<ShellEnvironment> {
  const processEnvironment = options?.processEnvironment ?? process.env;
  const processes = options?.processes ?? processRunner();
  const log = options?.log ?? silentLogger;
  const timeoutMs = options?.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS;

  const loginShell = await resolveLoginShell(
    processEnvironment,
    processes,
    timeoutMs,
    options?.account ?? accountInformation,
  );
  const inherited = withoutUndefined(processEnvironment);
  const resolved = await capture({ loginShell, inherited, processes, timeoutMs, log });

  return {
    loginShell,
    resolved,
    loginShellArguments: (): readonly string[] => [`-${basename(loginShell)}`],
  };
}

/**
 * Variables Janela sets on every terminal it starts.
 *
 * Keep this list short: every variable here is one the user cannot control, and
 * terminal programs are unusually sensitive to this namespace.
 *
 * @param projectName The owning project's name, or absent when the session is
 *   standalone.
 * @param automationEvent Set when this terminal runs a project automation command,
 *   so one script can branch on why it was invoked.
 */
export function janelaVariables(input: {
  readonly session: Session;
  readonly terminalID: TerminalID;
  readonly projectName?: string;
  readonly automationEvent?: AutomationEvent;
}): Readonly<Record<string, string>> {
  const branch = worktreeOf(input.session)?.branch;

  return {
    JANELA_SESSION_ID: input.session.id,
    JANELA_SESSION_NAME: input.session.name,
    JANELA_SESSION_DIRECTORY: input.session.directory,
    JANELA_TERMINAL_ID: input.terminalID,
    // Absent rather than empty: a script tests `set -u`-safely for the variable,
    // and an empty `JANELA_BRANCH` on a detached worktree would read as a branch
    // whose name is the empty string.
    ...(input.projectName === undefined ? {} : { JANELA_PROJECT: input.projectName }),
    ...(branch === undefined ? {} : { JANELA_BRANCH: branch }),
    ...(input.automationEvent === undefined
      ? {}
      : { JANELA_AUTOMATION_EVENT: input.automationEvent }),
  };
}

/**
 * `TERM`, and why it is what it is.
 *
 * Declaring `xterm-256color` rather than a bespoke terminfo entry means every
 * existing tool works on day one. Revisit only if we ship a terminfo file: the client renderer
 * and the daemon emulator must agree on what they claim to be, and they are two different
 * libraries now.
 */
export const DECLARED_TERM = "xterm-256color";

/**
 * The login shell, in the order that gets it right most often.
 *
 * `getpwuid` is the answer macOS itself uses, and `$SHELL` is only a hint — it is
 * whatever the *parent* was started with, which for a launchd daemon is nothing.
 */
async function resolveLoginShell(
  processEnvironment: Readonly<Record<string, string | undefined>>,
  processes: ProcessRunning,
  timeoutMs: number,
  readAccount: () => AccountInformation | undefined,
): Promise<string> {
  const account = readAccount();

  // Node returns `getpwuid`'s shell here. Bun returns "unknown", because it does
  // not call `getpwuid` — and `bun:ffi` is gated to `@janela/pty`, so we cannot
  // call it ourselves. The branch stays so the free path wins if Bun grows it.
  if (usable(account?.shell)) return account.shell;

  const username = usable(account?.username)
    ? account.username
    : // Bun reports "unknown" for the name as well, and launchd sets these.
      firstUsable(processEnvironment["USER"], processEnvironment["LOGNAME"]);
  if (username !== undefined) {
    const fromDirectoryService = await readDirectoryServiceShell(username, processes, timeoutMs);
    if (fromDirectoryService !== undefined) return fromDirectoryService;
  }

  const fromEnvironment = processEnvironment["SHELL"];
  if (fromEnvironment !== undefined && fromEnvironment.startsWith("/")) return fromEnvironment;

  return DEFAULT_LOGIN_SHELL;
}

/**
 * Whether a value from `os.userInfo()` is an answer.
 *
 * `"unknown"` is Bun's sentinel for "I did not look", for both fields. Passing it
 * on is worse than not asking: Directory Services answers `/Users/unknown` with
 * `UserShell: /usr/bin/false` and exit 0, which looks exactly like a real shell
 * and silently costs the user their whole environment.
 */
function usable(value: string | undefined): value is string {
  return value !== undefined && value !== "" && value !== "unknown";
}

function firstUsable(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => usable(value));
}

function accountInformation(): AccountInformation | undefined {
  try {
    const info = userInfo();
    return {
      ...(info.shell === null ? {} : { shell: info.shell }),
      username: info.username,
    };
  } catch {
    // No passwd entry for the uid. Nothing to recover here; the caller falls
    // through to `$USER` and then `$SHELL`.
    return undefined;
  }
}

/**
 * macOS keeps the record `getpwuid` reads in Directory Services, and `dscl` is the
 * supported way to ask it. Absent everywhere else, which is why it is behind
 * `which` rather than a platform check.
 */
async function readDirectoryServiceShell(
  username: string,
  processes: ProcessRunning,
  timeoutMs: number,
): Promise<string | undefined> {
  const path = "/usr/bin:/bin";
  const executable = await processes.which("dscl", path);
  if (executable === undefined) return undefined;

  try {
    const outcome = await processes.run({
      executable,
      arguments: [".", "-read", `/Users/${username}`, "UserShell"],
      workingDirectory: "/",
      environment: { PATH: path },
      timeoutMs,
    });
    if (!outcome.succeeded || outcome.timedOut) return undefined;

    for (const line of outcome.standardOutput.split("\n")) {
      if (!line.startsWith("UserShell:")) continue;
      const value = line.slice("UserShell:".length).trim();
      // Directory Services answers `UserShell: /bin/zsh`, and nothing else is a
      // shell we could exec.
      if (value.startsWith("/")) return value;
    }
  } catch {
    // `dscl` vanished between `which` and `run`, or is not executable.
  }
  return undefined;
}

/**
 * One interactive login shell, and never more than one.
 *
 * Interactive as well as login because that is where users put `PATH` edits, and
 * a `PATH` we did not capture is a launch profile we hide for no reason. Always
 * resolves: an unusable shell configuration must not stop the daemon from
 * serving, so the failure path is the daemon's own environment plus a warning.
 */
async function capture(input: {
  readonly loginShell: string;
  readonly inherited: Readonly<Record<string, string>>;
  readonly processes: ProcessRunning;
  readonly timeoutMs: number;
  readonly log: Logger;
}): Promise<Readonly<Record<string, string>>> {
  const shell = basename(input.loginShell);

  let outcome;
  try {
    outcome = await input.processes.run({
      executable: input.loginShell,
      arguments: ["-i", "-l", "-c", CAPTURE_SCRIPT],
      // The user's own shell may `cd` on start; `$HOME` is where a login shell
      // would have been started from anyway.
      workingDirectory: input.inherited["HOME"] ?? "/",
      environment: input.inherited,
      timeoutMs: input.timeoutMs,
    });
  } catch {
    input.log.warning("shell environment capture failed", {
      shell,
      exitCode: -1,
      timedOut: false,
      reason: "spawn",
    });
    return input.inherited;
  }

  if (outcome.timedOut || !outcome.succeeded) {
    input.log.warning("shell environment capture failed", {
      shell,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      reason: outcome.timedOut ? "timeout" : "exit",
    });
    return input.inherited;
  }

  const parsed = parseCapture(outcome.standardOutput);
  if (parsed === undefined) {
    input.log.warning("shell environment capture failed", {
      shell,
      exitCode: outcome.exitCode,
      timedOut: false,
      reason: "marker-missing",
    });
    return input.inherited;
  }

  input.log.info("shell environment captured", {
    shell,
    variables: Object.keys(parsed).length,
  });
  return parsed;
}

/** The variables after the last marker, or absent when there was no usable output. */
function parseCapture(standardOutput: string): Record<string, string> | undefined {
  // The *last* marker: a dotfile that prints the script itself (`set -x`) would
  // otherwise have us parse the trace.
  const marker = standardOutput.lastIndexOf(CAPTURE_MARKER);
  if (marker === -1) return undefined;

  const variables: Record<string, string> = {};
  for (const entry of standardOutput.slice(marker + CAPTURE_MARKER.length).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!VARIABLE_NAME.test(name) || CAPTURE_ARTEFACTS[name] === true) continue;
    variables[name] = entry.slice(separator + 1);
  }

  return Object.keys(variables).length === 0 ? undefined : variables;
}

/**
 * `process.env` holds `string | undefined`; a child's environment does not. An
 * unset variable is dropped rather than passed as the string "undefined".
 */
function withoutUndefined(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}
