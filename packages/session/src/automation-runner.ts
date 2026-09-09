import type {
  AutomationCommand,
  AutomationEvent,
  Project,
  Session,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import { newTerminalID, now } from "@janela/core";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { createLiveTerminal } from "@janela/terminal";

import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";
import { resolveTerminalLaunch } from "./terminal-launch.ts";

/**
 * Runs a project's automation commands.
 *
 * The one rule, and it is a product rule rather than an implementation choice:
 * **automation is visible.** Each command runs in a real terminal the user can
 * watch, scroll back through, and Ctrl-C — with `role: automation(event)`, in the
 * session's directory, with the session's environment. Nothing run on the user's
 * behalf happens in a hidden process, which is why this type creates terminals
 * rather than capturing output.
 *
 * What this is not: a task runner. There is no scheduling, no retry, no dependency
 * graph, and no conditional execution. Three events, a command each, in order.
 */
export interface AutomationRunning {
  /**
   * Runs every enabled command for `event`, in order, each in its own terminal.
   *
   * Returns once the terminals have been *created*, not once the commands have
   * finished — except for `sessionTeardown`, which is the one blocking event and is
   * bounded by each command's `timeoutSeconds`.
   *
   * A non-zero exit is visible and non-fatal: the terminal stays open showing why,
   * and the session is still usable.
   */
  run(request: {
    readonly event: AutomationEvent;
    readonly project: Project;
    readonly session: Session;
    /**
     * Where each created descriptor goes, *before* its process starts: the brain
     * appends it to `session.terminals`, persists and announces.
     *
     * A sink rather than a return value because a teardown terminal published
     * only once teardown finished is a terminal the user could never watch, which
     * is the whole product rule. A failure here is logged and the command still
     * runs — a client that vanished must not stop a teardown.
     */
    readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
  }): Promise<AutomationReport>;
}

export interface AutomationReport {
  readonly event: AutomationEvent;
  /** One per command that ran, in order. */
  readonly commands: readonly {
    readonly command: AutomationCommand;
    /** The terminal the command ran in. Absent when the launch could not be resolved. */
    readonly terminal?: TerminalID;
    /** Absent while still running, which is normal for everything but teardown. */
    readonly exitCode?: number;
    readonly timedOut: boolean;
    /** Set when no process ran: the executable was not found or the spawn failed. */
    readonly failure?: "launch";
  }[];
}

/** One command's outcome, as reported. */
type CommandReport = AutomationReport["commands"][number];

/**
 * How often a blocking teardown checks whether its command has exited.
 *
 * Polling rather than a completion callback because `LiveTerminal.events` is a
 * single sink the daemon owns for attention fan-out; claiming it here would
 * silently cost the user their notifications. The daemon's frame loop drains every
 * live terminal, so `state` is what advances — and 50 ms is far below the time any
 * teardown script takes.
 */
export const DEFAULT_AUTOMATION_POLL_MS = 50;

export interface AutomationRunnerDependencies {
  readonly terminals: TerminalRegistry;
  /** Captured once at startup; every automation terminal is launched from it. */
  readonly shell: ShellEnvironment;
  /** Resolves a command's executable on the captured `PATH`. */
  readonly processes?: ProcessRunning;
  /** The terminal-creation seam. Production passes nothing. */
  readonly createTerminal?: typeof createLiveTerminal;
  /** Where shapes go: an id, a count, an event name. Absent means silent. */
  readonly log?: Logger;
  /** How often a blocking teardown checks for exit. Test seam. */
  readonly pollIntervalMs?: number;
}

export function automationRunner(deps: AutomationRunnerDependencies): AutomationRunning {
  return new VisibleAutomationRunner(deps);
}

/**
 * The commands, in order, each in its own terminal.
 *
 * Note what this class cannot do: it reads `project.settings.automation` and
 * nothing else. There is no filesystem import here, deliberately — commands come
 * from Janela's own database, never from a file in the repository, because a
 * checkout that can add commands makes cloning a repo a code-execution vector.
 */
class VisibleAutomationRunner implements AutomationRunning {
  private readonly deps: AutomationRunnerDependencies;
  private readonly log: Logger;
  private readonly processes: ProcessRunning;
  private readonly pollIntervalMs: number;

  constructor(deps: AutomationRunnerDependencies) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
    this.processes = deps.processes ?? processRunner();
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_AUTOMATION_POLL_MS;
  }

  async run(request: {
    readonly event: AutomationEvent;
    readonly project: Project;
    readonly session: Session;
    readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
  }): Promise<AutomationReport> {
    const { event, session } = request;

    // Once per session, not once per app launch: the record is the persisted
    // automation-role descriptor itself — a terminal with
    // `role: automation(sessionStart)` in `session.terminals` is what "it ran"
    // looks like from the database, and it survives a daemon restart for free.
    // Checked once here rather than per command, because the sink appends this
    // run's own descriptors as it goes.
    const alreadyRan =
      event === "sessionStart" &&
      session.terminals.some(
        (terminal) => terminal.role.kind === "automation" && terminal.role.event === "sessionStart",
      );
    if (alreadyRan) {
      this.log.info("sessionStart automation already ran", { session: session.id });
      return { event, commands: [] };
    }

    const commands = request.project.settings.automation.filter(
      (candidate) => candidate.event === event && candidate.isEnabled,
    );

    const reports: CommandReport[] = [];
    for (const command of commands) {
      // Sequential by contract: "in order" is the only scheduling this has.
      // oxlint-disable-next-line no-await-in-loop
      reports.push(await this.runCommand({ ...request, command }));
    }

    this.log.info("automation ran", { session: session.id, event, commands: reports.length });
    return { event, commands: reports };
  }

  /**
   * One command: a descriptor, a launch, a terminal, and — for teardown only — a
   * bounded wait for it to exit.
   *
   * Every failure is this command's alone. A missing executable or a refused spawn
   * is logged as a shape and reported, and the caller runs the next command: one
   * broken script must not cost the user the rest of their teardown.
   */
  private async runCommand(input: {
    readonly event: AutomationEvent;
    readonly project: Project;
    readonly session: Session;
    readonly command: AutomationCommand;
    readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
  }): Promise<CommandReport> {
    const { command, event, project, session } = input;
    const shape = { session: session.id, event, command: command.id };

    const descriptor: TerminalDescriptor = {
      id: newTerminalID(),
      // The argv, which is what the user typed and what the tab should say.
      title: command.command.join(" "),
      // The runner starts it itself, and a restored session must not respawn a
      // command that already ran.
      startsAutomatically: false,
      role: { kind: "automation", event },
      createdAt: now(),
    };

    let launch;
    try {
      launch = await resolveTerminalLaunch({
        session,
        terminal: descriptor,
        project,
        // argv verbatim, no shell: `AutomationCommand.command` is an array
        // precisely so there is no quoting bug class here.
        command: command.command,
        automationEvent: event,
        shell: this.deps.shell,
        processes: this.processes,
      });
    } catch {
      this.log.warning("automation launch failed", shape);
      return { command, timedOut: false, failure: "launch" };
    }

    try {
      // Before the process starts, so the user can watch it from its first byte.
      await input.attach(descriptor);
    } catch {
      // The disconnected-client path. The command still runs: a teardown
      // abandoned because a window closed leaves exactly the containers it
      // exists to clean up.
      this.log.warning("automation attach failed", shape);
    }

    const create = this.deps.createTerminal ?? createLiveTerminal;
    const live = create({
      descriptor,
      sessionID: session.id,
      launch,
      ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
    });
    this.deps.terminals.register(live);

    try {
      await live.start();
    } catch {
      // Registered and left alone: its state says `failed`, and that is the
      // terminal the user opens to find out why.
      this.log.warning("automation start failed", shape);
      return { command, terminal: descriptor.id, timedOut: false, failure: "launch" };
    }

    if (event !== "sessionTeardown") {
      // Created, not completed: `worktreeCreated` and `sessionStart` commands do
      // not gate each other and nothing waits for them.
      return { command, terminal: descriptor.id, timedOut: false };
    }

    const state = await this.awaitExit(live, command.timeoutSeconds);
    if (state === undefined) {
      this.log.notice("automation teardown timed out", shape);
      // Deliberately not stopped here: `removeSession`'s stop-all loop is next,
      // and killing it twice would only make the report lie about which of us did.
      return { command, terminal: descriptor.id, timedOut: true };
    }
    if (state.kind !== "exited") {
      // `failed` is the spawn that never happened; nothing exited, so there is
      // no status to report.
      return { command, terminal: descriptor.id, timedOut: false, failure: "launch" };
    }
    return { command, terminal: descriptor.id, exitCode: state.code, timedOut: false };
  }

  /**
   * Waits for `live` to leave the running states, or for the deadline.
   *
   * Returns `undefined` on timeout. A zero or negative `timeoutSeconds` still gets
   * one look at the state, so a command that exited instantly is reported as
   * exited rather than as timed out.
   */
  private async awaitExit(
    live: LiveTerminal,
    timeoutSeconds: number,
  ): Promise<TerminalState | undefined> {
    const bound = Number.isFinite(timeoutSeconds) ? Math.max(0, timeoutSeconds) : 0;
    const deadline = Date.now() + bound * 1000;

    for (;;) {
      const state = live.state;
      if (state.kind === "exited" || state.kind === "failed") return state;
      if (Date.now() >= deadline) return undefined;
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.pollIntervalMs);
      });
    }
  }
}
