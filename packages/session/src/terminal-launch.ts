import type {
  AutomationEvent,
  GridSize,
  LaunchProfile,
  Project,
  Session,
  TerminalDescriptor,
} from "@janela/core";
import type { ProcessRunning } from "@janela/support/process";
import type { TerminalLaunch } from "@janela/terminal";

import { LaunchProfileUnavailable } from "./errors.ts";
import { DECLARED_TERM, janelaVariables, type ShellEnvironment } from "./shell-environment.ts";

/**
 * The size a terminal's PTY is created with before any client attaches.
 *
 * Something has to be chosen: `negotiatedSize([])` has no answer, and the child
 * may print before the first viewport arrives. 80×24 is what every tool expects
 * when it cannot ask, and the first `attach` resizes.
 */
export const DEFAULT_INITIAL_SIZE: GridSize = { columns: 80, rows: 24 };

/**
 * Everything needed to turn a descriptor into a resolved launch.
 *
 * `@janela/terminal` receives an answer rather than computing one, because this is
 * the only layer that knows about projects, profiles and the user's shell.
 */
export interface TerminalLaunchInput {
  readonly session: Session;
  readonly terminal: TerminalDescriptor;
  /** The owning project, when the session has one. Only its name is used. */
  readonly project?: Project;
  /** Resolved by the caller. Absent means the login shell. */
  readonly profile?: LaunchProfile;
  /** Overrides the profile's argv. This is how an automation command is run. */
  readonly command?: readonly string[];
  /** Set for an automation terminal, so one script can branch on why it ran. */
  readonly automationEvent?: AutomationEvent;
  readonly shell: ShellEnvironment;
  readonly processes: ProcessRunning;
}

/**
 * Resolves what to run, where, and with what environment.
 *
 * @throws {LaunchProfileUnavailable} when the argv's executable is not on the
 *   captured `PATH`. Resolving it here rather than letting `execve` fail means the
 *   user gets "Claude Code isn't installed." instead of an errno.
 */
export async function resolveTerminalLaunch(input: TerminalLaunchInput): Promise<TerminalLaunch> {
  const environment: Record<string, string> = {
    ...input.shell.resolved,
    ...input.profile?.environment,
    TERM: DECLARED_TERM,
    // Last, deliberately: `TERM` and the `JANELA_*` namespace are facts about the
    // terminal we created, and a profile that overrode them would be describing a
    // terminal that does not exist.
    ...janelaVariables({
      session: input.session,
      terminalID: input.terminal.id,
      ...(input.project === undefined ? {} : { projectName: input.project.name }),
      ...(input.automationEvent === undefined ? {} : { automationEvent: input.automationEvent }),
    }),
  };

  const workingDirectory = input.terminal.workingDirectoryOverride ?? input.session.directory;
  const argv = input.command ?? input.profile?.command ?? [];
  const first = argv[0];

  if (first === undefined) {
    // The login shell, with `argv[0]` dash-prefixed so the user's `.zprofile`
    // runs. This is the case that makes the app feel like Terminal.app.
    return {
      executable: input.shell.loginShell,
      arguments: input.shell.loginShellArguments(),
      workingDirectory,
      environment,
      initialSize: DEFAULT_INITIAL_SIZE,
    };
  }

  const executable = first.includes("/")
    ? first
    : await input.processes.which(first, environment["PATH"] ?? "/usr/bin:/bin");
  if (executable === undefined) {
    throw new LaunchProfileUnavailable(input.profile?.name ?? first);
  }

  return {
    executable,
    // `argv` verbatim: the child sees `argv[0]` as the user wrote it, which is what
    // a program printing its own usage line reports.
    arguments: argv,
    workingDirectory,
    environment,
    initialSize: DEFAULT_INITIAL_SIZE,
  };
}
