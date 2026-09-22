import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { IntegrationID, IntegrationOverview, IntegrationReport } from "@janela/core";
import type { Logger } from "@janela/support";
import type { ProcessRunning } from "@janela/support/process";
import { Effect, Option, Schema } from "effect";

import { claudeIntegration } from "./claude.ts";
import { codexIntegration } from "./codex.ts";
import { UnknownIntegration } from "./errors.ts";
import type {
  Integration,
  IntegrationFiles,
  IntegrationHome,
  IntegrationService,
} from "./integration.ts";
import { ompIntegration } from "./omp.ts";
import { opencodeIntegration } from "./opencode.ts";

export interface IntegrationServiceOptions {
  readonly home: IntegrationHome;
  readonly processes: ProcessRunning;
  readonly log?: Logger;
}

export const INTEGRATIONS: readonly Integration[] = [
  claudeIntegration,
  codexIntegration,
  opencodeIntegration,
  ompIntegration,
];

const FALLBACK_PATH = "/usr/bin:/bin";

const TEMPORARY_SUFFIX = ".janela-tmp";

const MISSING = "ENOENT";

const decodeErrno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

export function integrationFiles(): IntegrationFiles {
  return {
    read: (path: string): Promise<string | undefined> =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (cause: unknown) => cause,
        }).pipe(
          Effect.catch((cause: unknown) =>
            isMissing(cause) ? Effect.succeed(undefined) : Effect.die(cause),
          ),
        ),
      ),

    async write(path: string, text: string): Promise<void> {
      const staged = `${path}${TEMPORARY_SUFFIX}`;

      await mkdir(dirname(path), { recursive: true });
      await writeFile(staged, text, "utf8");
      await rename(staged, path);
    },

    remove: (path: string): Promise<void> =>
      Effect.runPromise(
        Effect.tryPromise({ try: () => unlink(path), catch: (cause: unknown) => cause }).pipe(
          Effect.catch((cause: unknown) =>
            isMissing(cause) ? Effect.succeed(undefined) : Effect.die(cause),
          ),
        ),
      ),

    canonical: (path: string): Promise<string> => canonicalPath(path),
  };
}

async function canonicalPath(path: string): Promise<string> {
  const parent = dirname(path);

  if (parent === path) return path;

  const resolved = await Effect.runPromise(
    Effect.tryPromise({ try: () => realpath(path), catch: (cause: unknown) => cause }).pipe(
      Effect.catch((cause: unknown) =>
        isMissing(cause)
          ? Effect.promise(async () => join(await canonicalPath(parent), basename(path)))
          : Effect.die(cause),
      ),
    ),
  );

  return resolved;
}

function find(id: IntegrationID): Integration {
  const integration = INTEGRATIONS.find((candidate) => candidate.id === id);

  if (integration === undefined) throw new UnknownIntegration({ integration: id });

  return integration;
}

export function createIntegrationService(options: IntegrationServiceOptions): IntegrationService {
  const log = options.log ?? silentLogger;
  const files = integrationFiles();
  const { home, processes } = options;

  return {
    async overview(): Promise<IntegrationOverview> {
      const path = home.environment["PATH"] ?? FALLBACK_PATH;
      const integrations = await Promise.all(
        INTEGRATIONS.map(async (integration): Promise<IntegrationReport> => {
          const [resolved, status] = await Promise.all([
            processes.which(integration.executable, path),
            integration.status(files, home),
          ]);

          log.debug("integration reviewed", {
            integration: integration.id,
            status: status.kind,
            available: resolved !== undefined,
          });

          return {
            id: integration.id,
            name: integration.name,
            executable: integration.executable,
            isAvailable: resolved !== undefined,
            configPath: integration.configPath(home),
            reports: integration.reports,
            status,
          };
        }),
      );

      return { integrations };
    },

    async install(id: IntegrationID): Promise<void> {
      const integration = find(id);

      await integration.install(files, home);

      log.info("integration installed", { integration: id });
    },

    async remove(id: IntegrationID): Promise<void> {
      const integration = find(id);

      await integration.remove(files, home);

      log.info("integration removed", { integration: id });
    },
  };
}

function isMissing(cause: unknown): boolean {
  return Option.match(decodeErrno(cause), {
    onNone: () => false,
    onSome: (errno) => errno.code === MISSING,
  });
}
