import type {
  AbsolutePath,
  GridSize,
  Project,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalState,
} from "@janela/core";
import { newTerminalID, now } from "@janela/core";
import type {
  GitOutcome,
  GitRunning,
  GitWorktree,
  WorktreeRemovalSafety,
  WorktreeIncluding,
  WorktreeServing,
} from "@janela/git";
import { GitFailure } from "@janela/git";
import type { LogRecord, Logger } from "@janela/support";
import type { ProcessOutcome, ProcessRequest, ProcessRunning } from "@janela/support/process";
import type { LiveTerminal, TerminalLaunch, createLiveTerminal } from "@janela/terminal";

import type { AutomationReport, AutomationRunning } from "./automation-runner.ts";
import type { StateObserving } from "./state-observing.ts";

/**
 * Fakes for `@janela/session`'s tests.
 *
 * What is faked here and why: the logic under test is a *decision* — what order
 * things happen in, what gets persisted, what the user is told — not a subprocess.
 * Git itself is not faked anywhere in this package: `@janela/git` tests it against
 * real repositories, and a git fake here would only prove our assumptions about
 * `worktree add`. What these fakes replace is the *sequencing* around it.
 *
 * Deliberately not exported from `index.ts`: they are this package's tests'
 * business, and a fake on a public API is a fake somebody ships.
 */

/**
 * A shared ordering log.
 *
 * Ordering is the contract `createSession` exists to keep — the copy before the
 * automation, the automation before the terminal — and the only way to assert it
 * is one clock every collaborator writes to.
 */
export interface EventLog {
  readonly entries: readonly string[];
  record(event: string): void;
}

export function eventLog(): EventLog {
  const entries: string[] = [];
  return {
    entries,
    record(event: string): void {
      entries.push(event);
    },
  };
}

export interface RecordingObserver {
  readonly observer: StateObserving;
  /** Every announced session list, copied at the moment of the call. */
  readonly sessionCalls: readonly (readonly Session[])[];
  readonly projectCalls: readonly (readonly Project[])[];
  /** Resolves on the *next* announcement, so a test never sleeps. */
  nextSessions(): Promise<readonly Session[]>;
  nextProjects(): Promise<readonly Project[]>;
}

export function recordingObserver(events?: EventLog): RecordingObserver {
  const sessionCalls: (readonly Session[])[] = [];
  const projectCalls: (readonly Project[])[] = [];
  const sessionWaiters: ((sessions: readonly Session[]) => void)[] = [];
  const projectWaiters: ((projects: readonly Project[]) => void)[] = [];

  return {
    observer: {
      async sessionsChanged(sessions: readonly Session[]): Promise<void> {
        // A snapshot: the service holds one array and mutates it, so a reference
        // would make every past announcement equal to the present.
        const announced = sessions.map((session) => structuredClone(session));
        sessionCalls.push(announced);
        const terminals = announced.reduce((total, session) => total + session.terminals.length, 0);
        events?.record(`publish[t=${terminals}]`);
        const waiter = sessionWaiters.shift();
        if (waiter !== undefined) waiter(announced);
      },
      async projectsChanged(projects: readonly Project[]): Promise<void> {
        const announced = projects.map((project) => structuredClone(project));
        projectCalls.push(announced);
        events?.record("projectsChanged");
        const waiter = projectWaiters.shift();
        if (waiter !== undefined) waiter(announced);
      },
    },
    sessionCalls,
    projectCalls,
    nextSessions: () =>
      new Promise<readonly Session[]>((resolve) => {
        sessionWaiters.push(resolve);
      }),
    nextProjects: () =>
      new Promise<readonly Project[]>((resolve) => {
        projectWaiters.push(resolve);
      }),
  };
}

export interface ScriptedGitOutcome {
  readonly standardOutput?: string;
  readonly standardError?: string;
  readonly exitCode?: number;
}

export interface ScriptedGit {
  readonly git: GitRunning;
  /** `args.join(" ")` for every invocation, in order. */
  readonly calls: readonly string[];
  /**
   * Blocks every subsequent invocation until the returned function is called.
   *
   * This is what lets a test assert that `addProject` announced *before* git ran,
   * without a timer: the probes cannot finish, so anything observed must have
   * happened first.
   */
  hold(): () => void;
}

/**
 * A `GitRunning` answering from a table keyed by argument prefix.
 *
 * Read-only git only: `@janela/session` never mutates a repository through this
 * interface, so `run` exists to fail loudly if something starts.
 */
export function scriptedGit(script?: Readonly<Record<string, ScriptedGitOutcome>>): ScriptedGit {
  const calls: string[] = [];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;

  const answer = async (args: readonly string[]): Promise<GitOutcome> => {
    const key = args.join(" ");
    calls.push(key);
    if (gate !== undefined) await gate;

    const match = Object.entries(script ?? {}).find(([prefix]) => key.startsWith(prefix));
    const outcome = match?.[1];
    const exitCode = outcome?.exitCode ?? (outcome === undefined ? 1 : 0);
    return {
      standardOutput: outcome?.standardOutput ?? "",
      standardError: outcome?.standardError ?? "",
      exitCode,
      succeeded: exitCode === 0,
    };
  };

  return {
    git: {
      async run(args: readonly string[]): Promise<string> {
        const outcome = await answer(args);
        if (!outcome.succeeded) {
          throw new GitFailure(args[0] ?? "git", outcome.exitCode, outcome.standardError);
        }
        return outcome.standardOutput;
      },
      probe: answer,
    },
    calls,
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

const refuseGit = (): never => {
  throw new Error("git must not run here");
};

/** A `GitRunning` that throws on any use, for proving a path runs no git at all. */
export function failingGit(): GitRunning {
  return { run: refuseGit, probe: refuseGit };
}

export interface FakeWorktrees {
  readonly worktrees: WorktreeServing;
  readonly created: readonly {
    readonly repository: AbsolutePath;
    readonly directory: AbsolutePath;
    readonly branch?: string;
    readonly startPoint?: string;
  }[];
  readonly removed: readonly {
    readonly directory: AbsolutePath;
    readonly repository: AbsolutePath;
    readonly force: boolean;
  }[];
  /** git's view, which the fake grows as worktrees are created. */
  readonly listed: readonly GitWorktree[];
}

export function fakeWorktrees(options?: {
  readonly listed?: readonly GitWorktree[];
  /**
   * How git canonicalises the requested path. Production really does return a
   * different string (`/var` against `/private/var`), and the session must adopt
   * git's answer rather than the one it asked with.
   */
  readonly canonicalise?: (directory: AbsolutePath) => AbsolutePath;
  readonly head?: string;
  readonly failCreate?: Error;
  readonly safety?: Partial<WorktreeRemovalSafety>;
  readonly events?: EventLog;
}): FakeWorktrees {
  const listed: GitWorktree[] = [...(options?.listed ?? [])];
  const created: {
    repository: AbsolutePath;
    directory: AbsolutePath;
    branch?: string;
    startPoint?: string;
  }[] = [];
  const removed: { directory: AbsolutePath; repository: AbsolutePath; force: boolean }[] = [];

  return {
    worktrees: {
      async worktrees(): Promise<readonly GitWorktree[]> {
        return listed;
      },

      async createWorktree(request): Promise<GitWorktree> {
        options?.events?.record("worktree.create");
        created.push({
          repository: request.repository,
          directory: request.directory,
          ...(request.branch === undefined ? {} : { branch: request.branch }),
          ...(request.startPoint === undefined ? {} : { startPoint: request.startPoint }),
        });
        if (options?.failCreate !== undefined) throw options.failCreate;

        const entry: GitWorktree = {
          path: (options?.canonicalise ?? ((directory) => directory))(request.directory),
          head: options?.head ?? "9f2a1c4e5b6d7a8091b2c3d4e5f60718293a4b5c",
          ...(request.branch === undefined ? {} : { branch: request.branch }),
          isBare: false,
          isDetached: request.branch === undefined,
          isPrunable: false,
        };
        listed.push(entry);
        return entry;
      },

      async removalSafety(): Promise<WorktreeRemovalSafety> {
        return {
          hasUncommittedChanges: false,
          hasUntrackedFiles: false,
          hasUnpushedCommits: false,
          isLocked: false,
          // Always false from git, which cannot know. The session layer overwrites
          // it, and that overwrite is what the removal plan tests check.
          hasRunningSessions: false,
          ...options?.safety,
        };
      },

      async removeWorktree(request): Promise<void> {
        options?.events?.record("worktree.remove");
        removed.push(request);
      },
    },
    created,
    removed,
    listed,
  };
}

export interface FakeInclude {
  readonly include: WorktreeIncluding;
  readonly copies: readonly {
    readonly repository: AbsolutePath;
    readonly worktree: AbsolutePath;
    readonly paths: readonly string[];
  }[];
}

export function fakeInclude(options: {
  readonly paths: readonly string[];
  readonly copied?: readonly string[];
  readonly failCopy?: Error;
  readonly events?: EventLog;
}): FakeInclude {
  const copies: {
    repository: AbsolutePath;
    worktree: AbsolutePath;
    paths: readonly string[];
  }[] = [];

  return {
    include: {
      async resolve(): Promise<readonly string[]> {
        return options.paths;
      },
      async copy(request) {
        options.events?.record("include.copy");
        copies.push(request);
        if (options.failCopy !== undefined) throw options.failCopy;
        return {
          copied: options.copied ?? options.paths,
          totalBytes: 0,
          usedFallbackCopy: false,
        };
      },
    },
    copies,
  };
}

export interface FakeAutomation {
  readonly automation: AutomationRunning;
  readonly runs: readonly { readonly event: string; readonly session: SessionID }[];
  /** Descriptors handed to the brain's sink, in order. */
  readonly attached: readonly TerminalDescriptor[];
}

export function fakeAutomation(options?: {
  readonly fail?: Error;
  readonly events?: EventLog;
  /**
   * Attach one automation terminal per run, which is what a real runner does
   * before starting anything. Off by default: most tests here are about the
   * creation order, and an extra terminal in every announcement would say
   * nothing about it.
   */
  readonly attaches?: boolean;
}): FakeAutomation {
  const runs: { event: string; session: SessionID }[] = [];
  const attached: TerminalDescriptor[] = [];

  return {
    automation: {
      async run(request): Promise<AutomationReport> {
        options?.events?.record(`automation.${request.event}`);
        runs.push({ event: request.event, session: request.session.id });
        if (options?.fail !== undefined) throw options.fail;
        if (options?.attaches === true) {
          const descriptor: TerminalDescriptor = {
            id: newTerminalID(),
            title: "fake",
            startsAutomatically: false,
            role: { kind: "automation", event: request.event },
            createdAt: now(),
          };
          attached.push(descriptor);
          await request.attach(descriptor);
        }
        return { event: request.event, commands: [] };
      },
    },
    runs,
    attached,
  };
}

export interface FakeTerminalHandle {
  readonly terminal: LiveTerminal;
  /** What the session layer resolved for this terminal. */
  readonly launch: TerminalLaunch;
  readonly starts: () => number;
  readonly stops: () => number;
  setState(state: TerminalState): void;
}

export interface FakeTerminalFactory {
  readonly create: typeof createLiveTerminal;
  readonly created: readonly FakeTerminalHandle[];
}

/**
 * A `createLiveTerminal` that spawns nothing.
 *
 * PTYs are not faked in this repository as a rule — but the thing under test here
 * is which launch the brain resolved and when it registered it, and a real PTY
 * would only add a child process to a test about bookkeeping.
 */
export function fakeCreateTerminal(events?: EventLog): FakeTerminalFactory {
  const created: FakeTerminalHandle[] = [];

  const create: typeof createLiveTerminal = (options) => {
    events?.record("terminal.create");
    const terminal = new FakeLiveTerminal(options.descriptor, options.sessionID);
    created.push({
      terminal,
      launch: options.launch,
      starts: () => terminal.startCount,
      stops: () => terminal.stopCount,
      setState: (state) => {
        terminal.state = state;
      },
    });
    return terminal;
  };

  return { create, created };
}

class FakeLiveTerminal implements LiveTerminal {
  readonly descriptor: TerminalDescriptor;
  readonly sessionID: SessionID;
  state: TerminalState = { kind: "idle" };
  events: LiveTerminal["events"] = undefined;
  startCount = 0;
  stopCount = 0;

  constructor(descriptor: TerminalDescriptor, sessionID: SessionID) {
    this.descriptor = descriptor;
    this.sessionID = sessionID;
  }

  get id(): TerminalDescriptor["id"] {
    return this.descriptor.id;
  }

  get displayTitle(): string {
    return this.descriptor.title;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.state = { kind: "running" };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.state = { kind: "exited", code: 0 };
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  send(): void {}

  attach(_client: string, viewport: GridSize): GridSize {
    return viewport;
  }

  detach(): GridSize | undefined {
    return undefined;
  }

  drain(): void {}

  repaintFor(): Uint8Array {
    return new Uint8Array(0);
  }

  fullRepaintFor(): Uint8Array {
    return new Uint8Array(0);
  }

  snapshotText(): string {
    return "";
  }
}

export interface ScriptedProcesses {
  readonly processes: ProcessRunning;
  readonly invocations: readonly ProcessRequest[];
  readonly whichCalls: readonly { readonly executable: string; readonly path: string }[];
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

  return {
    processes: {
      async run(request: ProcessRequest): Promise<ProcessOutcome> {
        invocations.push(request);
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

/**
 * A structural fake, for asserting that we log shapes rather than content.
 *
 * `@janela/test-support`'s recording sink is global and unimplemented; every
 * logger in this package is injected, so a local fake is enough.
 */
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
