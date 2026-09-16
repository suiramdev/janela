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
import {
  DECLARED_TERM,
  janelaVariables,
  type JanelaVariablesInput,
  type ShellEnvironment,
} from "./shell-environment.ts";

export interface TerminalLaunchInput {
  readonly session: Session;
  readonly terminal: TerminalDescriptor;
  readonly project?: Project;
  readonly profile?: LaunchProfile;
  readonly command?: readonly string[];
  readonly automationEvent?: AutomationEvent;
  readonly shell: ShellEnvironment;
  readonly processes: ProcessRunning;
}

type MutableVariablesInput = {
  -readonly [Key in keyof JanelaVariablesInput]: JanelaVariablesInput[Key];
};

export const DEFAULT_INITIAL_SIZE: GridSize = { columns: 80, rows: 24 };

const FALLBACK_PATH = "/usr/bin:/bin";

export async function resolveTerminalLaunch(input: TerminalLaunchInput): Promise<TerminalLaunch> {
  const variables: MutableVariablesInput = {
    session: input.session,
    terminalID: input.terminal.id,
  };

  if (input.project !== undefined) variables.projectName = input.project.name;

  if (input.automationEvent !== undefined) variables.automationEvent = input.automationEvent;

  const environment: TerminalLaunch["environment"] = {
    ...input.shell.resolved,
    ...input.profile?.environment,
    TERM: DECLARED_TERM,
    ...janelaVariables(variables),
  };

  const workingDirectory = input.terminal.workingDirectoryOverride ?? input.session.directory;
  const argv = input.command ?? input.profile?.command ?? [];
  const first = argv[0];

  if (first === undefined) {
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
    : await input.processes.which(first, environment["PATH"] ?? FALLBACK_PATH);

  if (executable === undefined) {
    throw new LaunchProfileUnavailable(input.profile?.name ?? first);
  }

  return {
    executable,
    arguments: argv,
    workingDirectory,
    environment,
    initialSize: DEFAULT_INITIAL_SIZE,
  };
}
