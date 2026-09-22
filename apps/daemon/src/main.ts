import { defaultDatabasePath } from "@janela/db";
import { log, type Logger } from "@janela/support";
import { Effect, Match } from "effect";

import { parseDaemonArguments, USAGE } from "./arguments.ts";
import { daemonEnvironment, type DaemonEnvironment } from "./environment.ts";
import { createIdleMonitor, isDaemonIdle, shutdown } from "./lifecycle.ts";
import { defaultLogPath, installDaemonLogSink } from "./log-file.ts";

const JANELAD_VERSION = "0.1.0";

const EXIT_REFUSED_ARGUMENT = 2;

const EXIT_START_FAILED = 1;

function refuse(problem: string): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stderr.write(`janelad: ${problem}\n${USAGE}`);
    process.exit(EXIT_REFUSED_ARGUMENT);
  });
}

function starting(foreground: boolean, logger: Logger): Effect.Effect<DaemonEnvironment> {
  return Effect.tryPromise({
    try: () => daemonEnvironment({ databasePath: defaultDatabasePath(), foreground }),
    catch: (cause: unknown) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.sync(() => {
        logger.error("daemon start failed", {
          error: cause instanceof Error ? cause.name : "unknown",
        });

        return process.exit(EXIT_START_FAILED);
      }),
    ),
  );
}

function serving(foreground: boolean): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          installDaemonLogSink({ path: defaultLogPath(), mirrorToStderr: foreground }),
        ),
        (sink) => Effect.sync(() => sink.close()),
      );

      const logger = log("app");
      const environment = yield* Effect.acquireRelease(starting(foreground, logger), (open) =>
        Effect.promise(() => open.database.close()),
      );

      const controller = new AbortController();

      const stop = (): void => {
        void shutdown({
          terminals: environment.terminals,
          log: logger,
          stopServing: () => controller.abort(),
          finish: (code) => process.exit(code),
        });
      };

      yield* Effect.sync(() => {
        process.once("SIGTERM", stop);
        process.once("SIGINT", stop);
        process.on("SIGPIPE", () => {});
      });

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const idle = createIdleMonitor({
            isIdle: () => isDaemonIdle(environment.server),
            onIdleExpired: stop,
          });

          idle.start();

          return idle;
        }),
        (idle) => Effect.sync(() => idle.stop()),
      );

      yield* Effect.tryPromise({
        try: () => environment.serve(controller.signal),
        catch: (cause: unknown) => cause,
      });
    }),
  );
}

function main(argv: readonly string[]): Promise<void> {
  return Effect.runPromise(
    Match.value(parseDaemonArguments(argv)).pipe(
      Match.discriminatorsExhaustive("kind")({
        usage: (refused) => refuse(refused.problem),
        version: () =>
          Effect.sync(() => {
            process.stdout.write(`${JANELAD_VERSION}\n`);
          }),
        serve: (run) => serving(run.foreground),
      }),
    ),
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
