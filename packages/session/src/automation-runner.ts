import type {
  AutomationEvent,
  AutomationScript,
  Project,
  Session,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import { automationScriptOf, newTerminalID, now } from "@janela/core";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { createLiveTerminal } from "@janela/terminal";
import { Duration, Effect, Option } from "effect";

import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";
import { resolveTerminalLaunch } from "./terminal-launch.ts";

export interface AutomationRunning {
  run(request: AutomationRequest): Promise<AutomationReport>;
}

export interface AutomationRequest {
  readonly event: AutomationEvent;
  readonly project: Project;
  readonly session: Session;
  readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
}

export interface AutomationReport {
  readonly event: AutomationEvent;
  readonly outcome?: AutomationOutcome;
}

export interface AutomationOutcome {
  readonly terminal?: TerminalID;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly failure?: "launch";
}

export interface AutomationRunnerDependencies {
  readonly terminals: TerminalRegistry;
  readonly shell: ShellEnvironment;
  readonly processes?: ProcessRunning;
  readonly createTerminal?: typeof createLiveTerminal;
  readonly log?: Logger;
  readonly pollIntervalMs?: number;
}

type ScriptShape = {
  readonly session: Session["id"];
  readonly event: AutomationEvent;
};

export const DEFAULT_AUTOMATION_POLL_MS = 50;

export function automationRunner(deps: AutomationRunnerDependencies): AutomationRunning {
  return new VisibleAutomationRunner(deps);
}

export function automationTitle(event: AutomationEvent, script: string): string {
  const first = script
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  return first ?? event;
}

function settledState(state: TerminalState): TerminalState | undefined {
  return state.kind === "exited" || state.kind === "failed" ? state : undefined;
}

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

  async run(request: AutomationRequest): Promise<AutomationReport> {
    const { event, session } = request;

    const alreadyRan =
      event === "sessionStart" &&
      session.terminals.some(
        (terminal) => terminal.role.kind === "automation" && terminal.role.event === "sessionStart",
      );

    if (alreadyRan) {
      this.log.info("sessionStart automation already ran", { session: session.id });

      return { event };
    }

    const script = automationScriptOf(request.project.settings, event);

    if (script === undefined) return { event };

    const outcome = await this.runScript(request, script);

    this.log.info("automation ran", { session: session.id, event });

    return { event, outcome };
  }

  private async runScript(
    request: AutomationRequest,
    script: AutomationScript,
  ): Promise<AutomationOutcome> {
    const { event, project, session } = request;
    const shape: ScriptShape = { session: session.id, event };

    const descriptor: TerminalDescriptor = {
      id: newTerminalID(),
      title: automationTitle(event, script.script),
      startsAutomatically: false,
      role: { kind: "automation", event },
      createdAt: now(),
    };

    const launch = await Effect.runPromise(
      Effect.option(
        Effect.tryPromise({
          try: () =>
            resolveTerminalLaunch({
              session,
              terminal: descriptor,
              project,
              script: script.script,
              automationEvent: event,
              shell: this.deps.shell,
              processes: this.processes,
            }),
          catch: (cause: unknown) => cause,
        }),
      ).pipe(Effect.map(Option.getOrUndefined)),
    );

    if (launch === undefined) {
      this.log.warning("automation launch failed", shape);

      return { timedOut: false, failure: "launch" };
    }

    const attached = await Effect.runPromise(
      Effect.tryPromise({
        try: () => request.attach(descriptor),
        catch: (cause: unknown) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
    );

    if (!attached) this.log.warning("automation attach failed", shape);

    const create = this.deps.createTerminal ?? createLiveTerminal;
    const live = create({
      descriptor,
      sessionID: session.id,
      launch,
      log: this.log,
    });

    this.deps.terminals.register(live);

    const started = await Effect.runPromise(
      Effect.tryPromise({
        try: () => live.start(),
        catch: (cause: unknown) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
    );

    if (!started) {
      this.log.warning("automation start failed", shape);

      return { terminal: descriptor.id, timedOut: false, failure: "launch" };
    }

    if (event !== "sessionTeardown") {
      return { terminal: descriptor.id, timedOut: false };
    }

    const state = await this.awaitExit(live, script.timeoutSeconds);

    if (state === undefined) {
      this.log.notice("automation teardown timed out", shape);

      return { terminal: descriptor.id, timedOut: true };
    }

    if (state.kind !== "exited") {
      return { terminal: descriptor.id, timedOut: false, failure: "launch" };
    }

    return { terminal: descriptor.id, exitCode: state.code, timedOut: false };
  }

  private awaitExit(
    live: LiveTerminal,
    timeoutSeconds: number,
  ): Promise<TerminalState | undefined> {
    const immediate = settledState(live.state);

    if (immediate !== undefined) return Promise.resolve(immediate);

    const bound = Number.isFinite(timeoutSeconds) ? Math.max(0, timeoutSeconds) : 0;
    const interval = Duration.millis(this.pollIntervalMs);

    return Effect.runPromise(
      Effect.timeoutOption(
        Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(interval);

            const state = settledState(live.state);

            if (state !== undefined) return state;
          }
        }),
        Duration.millis(bound * 1000),
      ).pipe(Effect.map(Option.getOrUndefined)),
    );
  }
}
