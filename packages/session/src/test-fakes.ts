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
  WorktreeIncluding,
  WorktreeRemovalSafety,
  WorktreeServing,
} from "@janela/git";
import { GitFailure } from "@janela/git";
import type { LogRecord, Logger } from "@janela/support";
import type { ProcessOutcome, ProcessRequest, ProcessRunning } from "@janela/support/process";
import type { LiveTerminal, TerminalLaunch, createLiveTerminal } from "@janela/terminal";

import type { AutomationReport, AutomationRunning } from "./automation-runner.ts";
import type { StateObserving } from "./state-observing.ts";

export interface EventLog {
  readonly entries: readonly string[];
  record(event: string): void;
}

export interface RecordingObserver {
  readonly observer: StateObserving;
  readonly sessionCalls: readonly (readonly Session[])[];
  readonly projectCalls: readonly (readonly Project[])[];
  nextSessions(): Promise<readonly Session[]>;
  nextProjects(): Promise<readonly Project[]>;
}

export interface ScriptedGitOutcome {
  readonly standardOutput?: string;
  readonly standardError?: string;
  readonly exitCode?: number;
}

export interface ScriptedGit {
  readonly git: GitRunning;
  readonly calls: readonly string[];
  hold(): () => void;
}

export interface RecordedWorktreeCreation {
  readonly repository: AbsolutePath;
  readonly directory: AbsolutePath;
  readonly branch?: string;
  readonly startPoint?: string;
  readonly force?: boolean;
}

export interface RecordedWorktreeRemoval {
  readonly directory: AbsolutePath;
  readonly repository: AbsolutePath;
  readonly force: boolean;
}

export interface RecordedCheckout {
  readonly repository: AbsolutePath;
  readonly branch: string;
}

export interface FakeWorktreeOptions {
  readonly listed?: readonly GitWorktree[];
  readonly canonicalise?: (directory: AbsolutePath) => AbsolutePath;
  readonly head?: string;
  readonly failCreate?: Error;
  readonly safety?: Partial<WorktreeRemovalSafety>;
  readonly events?: EventLog;
  readonly branches?: readonly string[];
}

export interface FakeWorktrees {
  readonly worktrees: WorktreeServing;
  readonly created: readonly RecordedWorktreeCreation[];
  readonly removed: readonly RecordedWorktreeRemoval[];
  readonly checkedOut: readonly RecordedCheckout[];
  readonly listed: readonly GitWorktree[];
}

export interface RecordedIncludeCopy {
  readonly repository: AbsolutePath;
  readonly worktree: AbsolutePath;
  readonly paths: readonly string[];
}

export interface FakeIncludeOptions {
  readonly paths: readonly string[];
  readonly copied?: readonly string[];
  readonly failCopy?: Error;
  readonly events?: EventLog;
}

export interface FakeInclude {
  readonly include: WorktreeIncluding;
  readonly copies: readonly RecordedIncludeCopy[];
}

export interface FakeAutomationOptions {
  readonly fail?: Error;
  readonly events?: EventLog;
  readonly attaches?: boolean;
}

export interface FakeAutomation {
  readonly automation: AutomationRunning;
  readonly runs: readonly { readonly event: string; readonly session: SessionID }[];
  readonly attached: readonly TerminalDescriptor[];
}

export interface FakeTerminalHandle {
  readonly terminal: LiveTerminal;
  readonly launch: TerminalLaunch;
  readonly starts: () => number;
  readonly stops: () => number;
  setState(state: TerminalState): void;
}

export interface FakeTerminalFactory {
  readonly create: typeof createLiveTerminal;
  readonly created: readonly FakeTerminalHandle[];
}

export interface ScriptedProcesses {
  readonly processes: ProcessRunning;
  readonly invocations: readonly ProcessRequest[];
  readonly whichCalls: readonly { readonly executable: string; readonly path: string }[];
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

export type ScriptedOutcome = Partial<ProcessOutcome> | Error;

type MutableWorktreeCreation = {
  -readonly [Key in keyof RecordedWorktreeCreation]: RecordedWorktreeCreation[Key];
};

type MutableGitWorktree = { -readonly [Key in keyof GitWorktree]: GitWorktree[Key] };

const DEFAULT_WORKTREE_HEAD = "9f2a1c4e5b6d7a8091b2c3d4e5f60718293a4b5c";

const refuseGit = (): never => {
  throw new Error("git must not run here");
};

export function eventLog(): EventLog {
  const entries: string[] = [];

  return {
    entries,
    record(event: string): void {
      entries.push(event);
    },
  };
}

export function recordingObserver(events: EventLog = eventLog()): RecordingObserver {
  const sessionCalls: (readonly Session[])[] = [];
  const projectCalls: (readonly Project[])[] = [];
  const sessionWaiters: ((sessions: readonly Session[]) => void)[] = [];
  const projectWaiters: ((projects: readonly Project[]) => void)[] = [];

  return {
    observer: {
      async sessionsChanged(sessions: readonly Session[]): Promise<void> {
        const announced = sessions.map((session) => structuredClone(session));
        sessionCalls.push(announced);

        const terminals = announced.reduce((total, session) => total + session.terminals.length, 0);
        events.record(`publish[t=${terminals}]`);

        const waiter = sessionWaiters.shift();

        if (waiter !== undefined) waiter(announced);
      },
      async projectsChanged(projects: readonly Project[]): Promise<void> {
        const announced = projects.map((project) => structuredClone(project));
        projectCalls.push(announced);
        events.record("projectsChanged");

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

export function scriptedGit(
  script: Readonly<Record<string, ScriptedGitOutcome>> = {},
): ScriptedGit {
  const calls: string[] = [];
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;

  const answer = async (args: readonly string[]): Promise<GitOutcome> => {
    const key = args.join(" ");
    calls.push(key);

    if (gate !== undefined) await gate;

    const match = Object.entries(script).find(([prefix]) => key.startsWith(prefix));
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

export function failingGit(): GitRunning {
  return { run: refuseGit, probe: refuseGit };
}

export function fakeWorktrees(options: FakeWorktreeOptions = {}): FakeWorktrees {
  const listed: GitWorktree[] = [...(options.listed ?? [])];
  const created: RecordedWorktreeCreation[] = [];
  const removed: RecordedWorktreeRemoval[] = [];
  const checkedOut: RecordedCheckout[] = [];

  return {
    worktrees: {
      async worktrees(): Promise<readonly GitWorktree[]> {
        return listed;
      },

      async branches(): Promise<readonly string[]> {
        return options.branches ?? [];
      },

      async checkoutBranch(repository, branch): Promise<void> {
        options.events?.record("worktree.checkout");
        checkedOut.push({ repository, branch });
      },

      async createWorktree(request): Promise<GitWorktree> {
        options.events?.record("worktree.create");

        const recorded: MutableWorktreeCreation = {
          repository: request.repository,
          directory: request.directory,
        };

        if (request.branch !== undefined) recorded.branch = request.branch;

        if (request.startPoint !== undefined) recorded.startPoint = request.startPoint;

        if (request.force !== undefined) recorded.force = request.force;

        created.push(recorded);

        if (options.failCreate !== undefined) throw options.failCreate;

        const entry: MutableGitWorktree = {
          path: (options.canonicalise ?? ((directory) => directory))(request.directory),
          head: options.head ?? DEFAULT_WORKTREE_HEAD,
          isBare: false,
          isDetached: request.branch === undefined,
          isPrunable: false,
        };

        if (request.branch !== undefined) entry.branch = request.branch;

        listed.push(entry);

        return entry;
      },

      async removalSafety(): Promise<WorktreeRemovalSafety> {
        return {
          hasUncommittedChanges: false,
          hasUntrackedFiles: false,
          hasUnpushedCommits: false,
          isLocked: false,
          hasRunningSessions: false,
          ...options.safety,
        };
      },

      async removeWorktree(request): Promise<void> {
        options.events?.record("worktree.remove");
        removed.push(request);
      },
    },
    created,
    removed,
    checkedOut,
    listed,
  };
}

export function fakeInclude(options: FakeIncludeOptions): FakeInclude {
  const copies: RecordedIncludeCopy[] = [];

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

export function fakeAutomation(options: FakeAutomationOptions = {}): FakeAutomation {
  const runs: { event: string; session: SessionID }[] = [];
  const attached: TerminalDescriptor[] = [];

  return {
    automation: {
      async run(request): Promise<AutomationReport> {
        options.events?.record(`automation.${request.event}`);
        runs.push({ event: request.event, session: request.session.id });

        if (options.fail !== undefined) throw options.fail;

        if (options.attaches === true) {
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

        return { event: request.event };
      },
    },
    runs,
    attached,
  };
}

export function fakeCreateTerminal(events: EventLog = eventLog()): FakeTerminalFactory {
  const created: FakeTerminalHandle[] = [];

  const create: typeof createLiveTerminal = (options) => {
    events.record("terminal.create");

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

export function scriptedProcesses(options: ScriptedProcessesOptions = {}): ScriptedProcesses {
  const invocations: ProcessRequest[] = [];
  const whichCalls: { executable: string; path: string }[] = [];
  const queued = [...(options.outcomes ?? [])];

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

        return options.which?.[executable];
      },
    },
    invocations,
    whichCalls,
  };
}

export function recordingLogger(): RecordingLogger {
  const records: RecordedLog[] = [];
  const at =
    (level: RecordedLog["level"]) =>
    (message: string, fields: LogRecord["fields"] = undefined): void => {
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
