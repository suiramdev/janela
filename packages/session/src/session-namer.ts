import type {
  SessionID,
  SessionNamerID,
  SessionNamerReport,
  SessionNaming,
  SessionNamingOverview,
} from "@janela/core";
import { SESSION_NAMER_IDS, SESSION_NAMING_OFF, acceptsAutomaticName } from "@janela/core";
import type { SettingsRepository } from "@janela/db";
import type { Logger } from "@janela/support";
import type { ProcessOutcome, ProcessRunning } from "@janela/support/process";
import { Effect } from "effect";

import {
  EMPTY_NAMING_HISTORY,
  namingDue,
  namingInstruction,
  recordAttempt,
  rememberPrompt,
  sessionNameFromReply,
  type NamingHistory,
} from "./session-naming-policy.ts";
import type { SessionService } from "./session-service.ts";
import { silentLogger } from "./silent-logger.ts";

export interface SessionNamer {
  load(): Promise<void>;
  overview(): Promise<SessionNamingOverview>;
  configure(naming: SessionNaming): Promise<void>;
  promptSubmitted(sessionID: SessionID, prompt: string): Promise<void>;
}

export interface SessionNamerDependencies {
  readonly sessions: Pick<SessionService, "find" | "nameAutomatically">;
  readonly settings: SettingsRepository;
  readonly processes: ProcessRunning;
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly clock?: () => number;
  readonly log?: Logger;
  readonly timeoutMs?: number;
}

export interface NamerInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
}

interface NamerSpec {
  readonly name: string;
  readonly executable: string;
  readonly defaultModel?: string;
  readonly arguments: (model: string | undefined, instruction: string) => readonly string[];
}

export const MAX_CONCURRENT_NAMERS = 2;

export const NAMER_TIMEOUT_MILLISECONDS = 30_000;

const FALLBACK_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";

const STRIPPED_VARIABLES: Readonly<Record<string, true>> = { JANELA_TTY: true };

export const NAMER_SYSTEM_PROMPT =
  "You name terminal sessions after the work they are for. Reply with the name and nothing else.";

const optional = (flag: string, value: string | undefined): readonly string[] =>
  value === undefined ? [] : [flag, value];

const NAMERS: Readonly<Record<SessionNamerID, NamerSpec>> = {
  claude: {
    name: "Claude Code",
    executable: "claude",
    defaultModel: "haiku",
    arguments: (model, instruction) => [
      "--print",
      ...optional("--model", model),
      "--system-prompt",
      NAMER_SYSTEM_PROMPT,
      "--tools",
      "",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      instruction,
    ],
  },
  codex: {
    name: "Codex",
    executable: "codex",
    arguments: (model, instruction) => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      ...optional("--model", model),
      instruction,
    ],
  },
  omp: {
    name: "Oh My Pi",
    executable: "omp",
    arguments: (model, instruction) => [
      "--print",
      "--no-tools",
      "--no-session",
      ...optional("--model", model),
      instruction,
    ],
  },
};

export function namerInvocation(naming: SessionNaming, instruction: string): NamerInvocation {
  if (naming.kind === "off") throw new TypeError("session naming is off");

  const spec = NAMERS[naming.agent];
  const model = naming.model ?? spec.defaultModel;

  return { executable: spec.executable, arguments: spec.arguments(model, instruction) };
}

export function namerEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => STRIPPED_VARIABLES[name] !== true),
  );
}

export function createSessionNamer(deps: SessionNamerDependencies): SessionNamer {
  const log = deps.log ?? silentLogger;
  const clock = deps.clock ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? NAMER_TIMEOUT_MILLISECONDS;
  const environment = namerEnvironment(deps.environment);
  const searchPath = environment["PATH"] ?? FALLBACK_PATH;
  const histories = new Map<SessionID, NamingHistory>();
  const inFlight = new Set<SessionID>();
  let naming: SessionNaming = SESSION_NAMING_OFF;

  const forgetGone = (): void => {
    for (const id of histories.keys()) {
      const session = deps.sessions.find(id);

      if (session === undefined || !acceptsAutomaticName(session)) histories.delete(id);
    }
  };

  const ask = (instruction: string, at: SessionNaming): Promise<ProcessOutcome | undefined> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const invocation = namerInvocation(at, instruction);
        const executable = yield* Effect.promise(() =>
          deps.processes.which(invocation.executable, searchPath),
        );

        if (executable === undefined) return undefined;

        return yield* Effect.tryPromise(() =>
          deps.processes.run({
            executable,
            arguments: invocation.arguments,
            workingDirectory: deps.workingDirectory,
            environment,
            timeoutMs,
          }),
        );
      }).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );

  const name = async (sessionID: SessionID, history: NamingHistory): Promise<void> => {
    const session = deps.sessions.find(sessionID);

    if (session === undefined) return;

    const current = session.nameOrigin === "automatic" ? session.name : undefined;
    const startedAt = clock();
    const outcome = await ask(namingInstruction(history.prompts, current), naming);
    const proposed =
      outcome?.succeeded === true ? sessionNameFromReply(outcome.standardOutput) : undefined;

    const latest = histories.get(sessionID) ?? history;

    histories.set(
      sessionID,
      recordAttempt(
        latest,
        { afterPrompt: history.substantive, at: startedAt },
        proposed === undefined ? "failed" : "named",
      ),
    );

    const renamed =
      proposed !== undefined && (await deps.sessions.nameAutomatically(sessionID, proposed));

    log.info("session naming finished", {
      sessionID,
      outcome: proposed === undefined ? "failed" : renamed ? "renamed" : "kept",
      timedOut: outcome?.timedOut === true,
      milliseconds: clock() - startedAt,
    });
  };

  return {
    async load(): Promise<void> {
      naming = await deps.settings.sessionNaming();
    },

    async overview(): Promise<SessionNamingOverview> {
      const namers = await Promise.all(
        SESSION_NAMER_IDS.map(async (id): Promise<SessionNamerReport> => {
          const spec = NAMERS[id];
          const isAvailable =
            (await deps.processes.which(spec.executable, searchPath)) !== undefined;

          const report = { id, name: spec.name, executable: spec.executable, isAvailable };

          return spec.defaultModel === undefined
            ? report
            : { ...report, defaultModel: spec.defaultModel };
        }),
      );

      return { naming, namers };
    },

    async configure(next: SessionNaming): Promise<void> {
      await deps.settings.saveSessionNaming(next);
      naming = next;

      if (next.kind === "off") histories.clear();

      log.info("session naming configured", {
        naming: next.kind === "off" ? "off" : next.agent,
      });
    },

    async promptSubmitted(sessionID: SessionID, prompt: string): Promise<void> {
      if (naming.kind === "off") return;

      forgetGone();

      const session = deps.sessions.find(sessionID);

      if (session === undefined || !acceptsAutomaticName(session)) return;

      const history = rememberPrompt(histories.get(sessionID) ?? EMPTY_NAMING_HISTORY, prompt);

      histories.set(sessionID, history);

      if (!namingDue(history, session.nameOrigin, clock())) return;

      if (inFlight.has(sessionID) || inFlight.size >= MAX_CONCURRENT_NAMERS) return;

      inFlight.add(sessionID);

      await Effect.runPromise(
        Effect.tryPromise(() => name(sessionID, history)).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              log.warning("session naming failed", { sessionID });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              inFlight.delete(sessionID);
            }),
          ),
        ),
      );
    },
  };
}
