import { userInfo } from "node:os";
import { basename } from "node:path";

import type { AutomationEvent, Session, TerminalID } from "@janela/core";
import { worktreeOf } from "@janela/core";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import { Effect, Option } from "effect";

import { silentLogger } from "./silent-logger.ts";

export interface ShellEnvironment {
  readonly loginShell: string;
  readonly resolved: Readonly<Record<string, string>>;
  loginShellArguments(): readonly string[];
}

export interface ShellEnvironmentOptions {
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly processes?: ProcessRunning;
  readonly log?: Logger;
  readonly timeoutMs?: number;
  readonly account?: () => AccountInformation | undefined;
}

export interface AccountInformation {
  readonly shell?: string;
  readonly username?: string;
}

export interface JanelaVariablesInput {
  readonly session: Session;
  readonly terminalID: TerminalID;
  readonly projectName?: string;
  readonly automationEvent?: AutomationEvent;
}

export interface JanelaVariables {
  readonly JANELA_SESSION_ID: string;
  readonly JANELA_SESSION_NAME: string;
  readonly JANELA_SESSION_DIRECTORY: string;
  readonly JANELA_TERMINAL_ID: string;
  readonly JANELA_PROJECT?: string;
  readonly JANELA_BRANCH?: string;
  readonly JANELA_AUTOMATION_EVENT?: AutomationEvent;
}

interface CaptureInput {
  readonly loginShell: string;
  readonly inherited: ShellEnvironment["resolved"];
  readonly processes: ProcessRunning;
  readonly timeoutMs: number;
  readonly log: Logger;
}

type CaptureFailureReason = "spawn" | "timeout" | "exit" | "marker-missing";

type CaptureFailure = {
  readonly shell: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly reason: CaptureFailureReason;
};

type MutableVariables = {
  -readonly [Key in keyof JanelaVariables]: JanelaVariables[Key];
};

type MutableAccount = {
  -readonly [Key in keyof AccountInformation]: AccountInformation[Key];
};

export const SHELL_ENVIRONMENT_TIMEOUT_MS = 10_000;

export const DEFAULT_LOGIN_SHELL = "/bin/zsh";

export const DECLARED_TERM = "xterm-256color";

export const DECLARED_CONEMU_ANSI = "ON";

const CAPTURE_SCRIPT = "printf '\\0JANELA_ENVIRONMENT\\0'; /usr/bin/env -0";

const CAPTURE_MARKER = "\0JANELA_ENVIRONMENT\0";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CAPTURE_ARTEFACTS = { _: true, SHLVL: true, PWD: true, OLDPWD: true };

const DIRECTORY_SERVICE_PATH = "/usr/bin:/bin";

const DIRECTORY_SERVICE_ATTRIBUTE = "UserShell";

const UNASKED_SENTINEL = "unknown";

const SPAWN_EXIT_CODE = -1;

const readUserInfo = Option.liftThrowable(() => userInfo());

export async function resolveShellEnvironment(
  options: ShellEnvironmentOptions = {},
): Promise<ShellEnvironment> {
  const processEnvironment = options.processEnvironment ?? process.env;
  const processes = options.processes ?? processRunner();
  const log = options.log ?? silentLogger;
  const timeoutMs = options.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS;

  const loginShell = await resolveLoginShell(
    processEnvironment,
    processes,
    timeoutMs,
    options.account ?? accountInformation,
  );
  const inherited = withoutUndefined(processEnvironment);
  const resolved = await capture({ loginShell, inherited, processes, timeoutMs, log });

  return {
    loginShell,
    resolved,
    loginShellArguments: (): readonly string[] => [`-${basename(loginShell)}`],
  };
}

export function janelaVariables(input: JanelaVariablesInput): JanelaVariables {
  const branch = worktreeOf(input.session)?.branch;

  const variables: MutableVariables = {
    JANELA_SESSION_ID: input.session.id,
    JANELA_SESSION_NAME: input.session.name,
    JANELA_SESSION_DIRECTORY: input.session.directory,
    JANELA_TERMINAL_ID: input.terminalID,
  };

  if (input.projectName !== undefined) variables.JANELA_PROJECT = input.projectName;

  if (branch !== undefined) variables.JANELA_BRANCH = branch;

  if (input.automationEvent !== undefined) {
    variables.JANELA_AUTOMATION_EVENT = input.automationEvent;
  }

  return variables;
}

async function resolveLoginShell(
  processEnvironment: Readonly<Record<string, string | undefined>>,
  processes: ProcessRunning,
  timeoutMs: number,
  readAccount: () => AccountInformation | undefined,
): Promise<string> {
  const account = readAccount();

  if (usable(account?.shell)) return account.shell;

  const username = usable(account?.username)
    ? account.username
    : [processEnvironment["USER"], processEnvironment["LOGNAME"]].find((value) => usable(value));

  if (username !== undefined) {
    const fromDirectoryService = await readDirectoryServiceShell(username, processes, timeoutMs);

    if (fromDirectoryService !== undefined) return fromDirectoryService;
  }

  const fromEnvironment = processEnvironment["SHELL"];

  if (fromEnvironment !== undefined && fromEnvironment.startsWith("/")) return fromEnvironment;

  return DEFAULT_LOGIN_SHELL;
}

function usable(value: string | undefined): value is string {
  return value !== undefined && value !== "" && value !== UNASKED_SENTINEL;
}

function accountInformation(): AccountInformation | undefined {
  return Option.getOrUndefined(
    Option.map(readUserInfo(), (info) => {
      const account: MutableAccount = { username: info.username };

      if (info.shell !== null) account.shell = info.shell;

      return account;
    }),
  );
}

async function readDirectoryServiceShell(
  username: string,
  processes: ProcessRunning,
  timeoutMs: number,
): Promise<string | undefined> {
  const executable = await processes.which("dscl", DIRECTORY_SERVICE_PATH);

  if (executable === undefined) return undefined;

  const outcome = await Effect.runPromise(
    Effect.option(
      Effect.tryPromise({
        try: () =>
          processes.run({
            executable,
            arguments: [".", "-read", `/Users/${username}`, DIRECTORY_SERVICE_ATTRIBUTE],
            workingDirectory: "/",
            environment: { PATH: DIRECTORY_SERVICE_PATH },
            timeoutMs,
          }),
        catch: (cause: unknown) => cause,
      }),
    ).pipe(Effect.map(Option.getOrUndefined)),
  );

  if (outcome === undefined || !outcome.succeeded || outcome.timedOut) return undefined;

  return userShellFrom(outcome.standardOutput);
}

function userShellFrom(standardOutput: string): string | undefined {
  const prefix = `${DIRECTORY_SERVICE_ATTRIBUTE}:`;

  for (const line of standardOutput.split("\n")) {
    if (!line.startsWith(prefix)) continue;

    const value = line.slice(prefix.length).trim();

    if (value.startsWith("/")) return value;
  }

  return undefined;
}

async function capture(input: CaptureInput): Promise<ShellEnvironment["resolved"]> {
  const shell = basename(input.loginShell);

  const outcome = await Effect.runPromise(
    Effect.option(
      Effect.tryPromise({
        try: () =>
          input.processes.run({
            executable: input.loginShell,
            arguments: ["-i", "-l", "-c", CAPTURE_SCRIPT],
            workingDirectory: input.inherited["HOME"] ?? "/",
            environment: input.inherited,
            timeoutMs: input.timeoutMs,
          }),
        catch: (cause: unknown) => cause,
      }),
    ).pipe(Effect.map(Option.getOrUndefined)),
  );

  if (outcome === undefined) {
    return abandonCapture(input, {
      shell,
      exitCode: SPAWN_EXIT_CODE,
      timedOut: false,
      reason: "spawn",
    });
  }

  if (outcome.timedOut || !outcome.succeeded) {
    return abandonCapture(input, {
      shell,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      reason: outcome.timedOut ? "timeout" : "exit",
    });
  }

  const parsed = parseCapture(outcome.standardOutput);

  if (parsed === undefined) {
    return abandonCapture(input, {
      shell,
      exitCode: outcome.exitCode,
      timedOut: false,
      reason: "marker-missing",
    });
  }

  input.log.info("shell environment captured", { shell, variables: Object.keys(parsed).length });

  return parsed;
}

function abandonCapture(
  input: CaptureInput,
  failure: CaptureFailure,
): ShellEnvironment["resolved"] {
  input.log.warning("shell environment capture failed", failure);

  return input.inherited;
}

function parseCapture(standardOutput: string): Record<string, string> | undefined {
  const marker = standardOutput.lastIndexOf(CAPTURE_MARKER);

  if (marker === -1) return undefined;

  const variables: Record<string, string> = {};

  for (const entry of standardOutput.slice(marker + CAPTURE_MARKER.length).split("\0")) {
    const separator = entry.indexOf("=");

    if (separator <= 0) continue;

    const name = entry.slice(0, separator);

    if (!VARIABLE_NAME.test(name) || Object.hasOwn(CAPTURE_ARTEFACTS, name)) continue;

    variables[name] = entry.slice(separator + 1);
  }

  return Object.keys(variables).length === 0 ? undefined : variables;
}

function withoutUndefined(
  environment: Readonly<Record<string, string | undefined>>,
): ShellEnvironment["resolved"] {
  const defined: Record<string, string> = {};

  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) defined[name] = value;
  }

  return defined;
}
