import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AbsolutePath } from "@janela/core";
import { absolutePath } from "@janela/core";
import type { Logger } from "@janela/support";
import { Effect } from "effect";

import { PrismaClient } from "../generated/prisma/client.ts";
import { janelaSqliteAdapter } from "./adapter.ts";
import { MIGRATIONS, applyMigrations } from "./migrations.ts";
import {
  launchProfileRepository,
  projectRepository,
  sessionRepository,
} from "./prisma-repositories.ts";
import type {
  LaunchProfileRepository,
  ProjectRepository,
  SessionRepository,
} from "./repositories.ts";

export interface JanelaDatabase {
  migrate(): Promise<void>;
  close(): Promise<void>;

  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly launchProfiles: LaunchProfileRepository;
}

export interface OpenOptions {
  readonly path: AbsolutePath;
  readonly pragmas?: Readonly<Record<string, string>>;
  readonly log?: Logger;
}

export interface TemporaryDatabase extends JanelaDatabase {
  readonly path: AbsolutePath;
  dispose(): Promise<void>;
}

export interface TemporaryDatabaseOptions {
  readonly log?: Logger;
}

interface AdapterRequest {
  path: string;
  pragmas?: Readonly<Record<string, string>>;
}

interface OpenRequest {
  path: AbsolutePath;
  log?: Logger;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

export function defaultDatabasePath(): AbsolutePath {
  return absolutePath(
    join(homedir(), "Library", "Application Support", "sh.janela.Janela", "janela.sqlite"),
  );
}

export async function openDatabase(options: OpenOptions): Promise<JanelaDatabase> {
  const log = options.log ?? silentLogger;

  await mkdir(dirname(options.path), { recursive: true });

  const request: AdapterRequest = { path: options.path };

  if (options.pragmas !== undefined) request.pragmas = options.pragmas;

  const factory = janelaSqliteAdapter(request);
  const client = new PrismaClient({ adapter: factory });

  return {
    migrate(): Promise<void> {
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* Effect.acquireRelease(
              Effect.promise(() => factory.connect()),
              (open) => Effect.promise(() => open.dispose()),
            );

            yield* Effect.tryPromise({
              try: () => applyMigrations(connection, MIGRATIONS, log),
              catch: (cause: unknown) => cause,
            });
          }),
        ),
      );
    },

    close(): Promise<void> {
      return client.$disconnect();
    },

    projects: projectRepository(client, log),
    sessions: sessionRepository(client, log),
    launchProfiles: launchProfileRepository(client),
  };
}

export async function temporaryDatabase(
  options: TemporaryDatabaseOptions = {},
): Promise<TemporaryDatabase> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "janela-db-")));
  const path = absolutePath(join(directory, "janela.sqlite"));
  const request: OpenRequest = { path };

  if (options.log !== undefined) request.log = options.log;

  const database = await openDatabase(request);

  await database.migrate();

  return {
    ...database,
    path,
    async dispose(): Promise<void> {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
