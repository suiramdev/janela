import type { Project, Session } from "@janela/core";
import { absolutePath, emptyLayout, newProjectID, newSessionID, now } from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import type { ProcessOutcome, ProcessRequest, ProcessRunning } from "@janela/support/process";

export interface ScriptedProcesses {
  readonly processes: ProcessRunning;
  readonly invocations: readonly ProcessRequest[];
  readonly whichCalls: readonly { readonly executable: string; readonly path: string }[];
  hold(): () => void;
}

export interface ScriptedProcessesOptions {
  readonly outcomes?: readonly ScriptedOutcome[];
  readonly which?: Readonly<Record<string, string>>;
}

export interface RecordedLog {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: readonly RecordedLog[];
}

export interface ManualClock {
  now(): number;
  advance(milliseconds: number): void;
}

export type ScriptedOutcome = Partial<ProcessOutcome> | Error;

const CLOCK_START = 1_700_000_000_000;

export function scriptedProcesses(options: ScriptedProcessesOptions = {}): ScriptedProcesses {
  const invocations: ProcessRequest[] = [];
  const whichCalls: { executable: string; path: string }[] = [];
  const queued = [...(options.outcomes ?? [])];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;

  return {
    processes: {
      async run(request: ProcessRequest): Promise<ProcessOutcome> {
        invocations.push(request);

        if (gate !== undefined) await gate;

        const next = queued.shift();

        if (next instanceof Error) throw next;

        return {
          standardOutput: "",
          standardError: "",
          exitCode: 0,
          succeeded: true,
          timedOut: false,
          ...next,
        };
      },
      async which(executable: string, path: string): Promise<string | undefined> {
        whichCalls.push({ executable, path });

        return options.which?.[executable];
      },
    },
    invocations,
    whichCalls,
    hold(): () => void {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      return () => {
        gate = undefined;
        release?.();
      };
    },
  };
}

export function recordingLogger(): RecordingLogger {
  const records: RecordedLog[] = [];
  const at =
    (level: RecordedLog["level"]) =>
    (message: string, fields: LogRecord["fields"]): void => {
      records.push({ level, message, fields });
    };

  return {
    logger: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
  };
}

export function manualClock(start = CLOCK_START): ManualClock {
  let current = start;

  return {
    now: () => current,
    advance(milliseconds: number): void {
      current += milliseconds;
    },
  };
}

export function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: absolutePath("/Users/x/code/janela"),
    git: { forge: "gitHub", defaultBranch: "main" },
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: [], isForgeEnabled: true },
    accent: "none",
    isExpanded: true,
    addedAt: now(),
    ...overrides,
  };
}

export function fakeSession(overrides: Partial<Session> = {}): Session {
  const directory = absolutePath("/Users/x/code/.worktrees/feat-x");

  return {
    id: newSessionID(),
    name: "feat/x",
    directory,
    backing: {
      kind: "worktree",
      binding: { branch: "feat/x", path: directory, ownership: "managed", includedPaths: [] },
    },
    terminals: [],
    layout: emptyLayout,
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
    ...overrides,
  };
}
