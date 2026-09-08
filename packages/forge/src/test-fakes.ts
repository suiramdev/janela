import type { Project, Session } from "@janela/core";
import { absolutePath, emptyLayout, newProjectID, newSessionID, now } from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import type { ProcessOutcome, ProcessRequest, ProcessRunning } from "@janela/support/process";

/**
 * Fakes for `@janela/forge`'s tests.
 *
 * What is faked here is the *subprocess*, because the logic under test is the
 * decision: which argv we build, how a failure is classified, what we log, and
 * what the cache does with time. `gh` and `glab` themselves are exercised by the
 * real-CLI smoke run, not by a test that would only prove our assumptions.
 *
 * Deliberately not exported from `index.ts`: a fake on a public API is a fake
 * somebody ships. `@janela/session` has the same pair, and forge sits *below*
 * session, so this is a copy rather than an import.
 */

export interface ScriptedProcesses {
  readonly processes: ProcessRunning;
  readonly invocations: readonly ProcessRequest[];
  readonly whichCalls: readonly { readonly executable: string; readonly path: string }[];
  /**
   * Blocks every subsequent `run` until the returned function is called.
   *
   * This is what proves two concurrent `state()` calls share one invocation
   * without a timer: the first cannot finish, so a second invocation would have
   * to be a second entry in `invocations`.
   */
  hold(): () => void;
}

export type ScriptedOutcome = Partial<ProcessOutcome> | Error;

export function scriptedProcesses(options?: {
  /** Consumed in order. An `Error` rejects, which is how a spawn failure arrives. */
  readonly outcomes?: readonly ScriptedOutcome[];
  readonly which?: Readonly<Record<string, string>>;
}): ScriptedProcesses {
  const invocations: ProcessRequest[] = [];
  const whichCalls: { executable: string; path: string }[] = [];
  const queued = [...(options?.outcomes ?? [])];
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
        return options?.which?.[executable];
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

export interface RecordedLog {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: readonly RecordedLog[];
}

/** A structural fake, for asserting that we log shapes rather than content. */
export function recordingLogger(): RecordingLogger {
  const records: RecordedLog[] = [];
  const at =
    (level: RecordedLog["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
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

/** A clock the test moves by hand, so the cache's expiry is asserted, not slept through. */
export interface ManualClock {
  now(): number;
  advance(milliseconds: number): void;
}

export function manualClock(start = 1_700_000_000_000): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds: number): void {
      current += milliseconds;
    },
  };
}

export function fakeProject(overrides?: Partial<Project>): Project {
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

export function fakeSession(overrides?: Partial<Session>): Session {
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
