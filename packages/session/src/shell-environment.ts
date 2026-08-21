import type { AutomationEvent, Session, TerminalID } from "@janela/core";

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

/** Resolves the environment once. Called during daemon startup, off the critical path. */
export function resolveShellEnvironment(): Promise<ShellEnvironment> {
  throw new Error(`not implemented: resolveShellEnvironment`);
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
  void input;
  throw new Error(`not implemented: janelaVariables`);
}

/**
 * `TERM`, and why it is what it is.
 *
 * Declaring `xterm-256color` rather than a bespoke terminfo entry means every
 * existing tool works on day one. Revisit only if we ship a terminfo file, and read
 * docs/decisions/0018-terminal-engine.md first — the client renderer and the daemon
 * emulator must agree on what they claim to be, and they are two different
 * libraries now.
 */
export const DECLARED_TERM = "xterm-256color";
