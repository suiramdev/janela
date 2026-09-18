import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { absolutePath } from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import type { SqlDriverAdapter } from "@prisma/driver-adapter-utils";
import { Effect, Result } from "effect";

import { janelaSqliteAdapter } from "./adapter.ts";
import { defaultDatabasePath, openDatabase } from "./database.ts";
import { MigrationFailed } from "./errors.ts";
import { MIGRATIONS, MIGRATIONS_TABLE_DDL, applyMigrations } from "./migrations.ts";

interface Record_ {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

interface RecordingLogger {
  readonly logger: Logger;
  readonly records: Record_[];
}

interface MigrationRow {
  readonly migration_name: string;
  readonly checksum: string;
  readonly finished_at: string | null;
}

const TABLE_QUERY = `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;

function recordingLogger(): RecordingLogger {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
    (message: string, fields: LogRecord["fields"] | undefined): void => {
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

function withTemporaryDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "janela-migrations-"))),
          (created) => Effect.promise(() => rm(created, { recursive: true, force: true })),
        );

        return yield* Effect.tryPromise({
          try: () => work(directory),
          catch: (cause: unknown) => cause,
        });
      }),
    ),
  );
}

function readOnly<T>(path: string, read: (database: Database) => T): T {
  return Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(path, { readonly: true })),
          (open) =>
            Effect.sync(() => {
              open.close();
            }),
        );

        return yield* Effect.sync(() => read(database));
      }),
    ),
  );
}

function tableNames(path: string): string[] {
  return readOnly(path, (database) =>
    database
      .query<{ name: string }, []>(TABLE_QUERY)
      .all()
      .map((row) => row.name),
  );
}

async function tablesVisibleTo(connection: SqlDriverAdapter): Promise<string[]> {
  const { rows } = await connection.queryRaw({ sql: TABLE_QUERY, args: [], argTypes: [] });

  return rows.map((row) => String(row[0]));
}

function migrationRows(path: string): MigrationRow[] {
  return readOnly(path, (database) =>
    database
      .query<MigrationRow, []>(
        `SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY started_at`,
      )
      .all(),
  );
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  const outcome = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: () => work, catch: (cause: unknown) => cause })),
  );

  if (Result.isSuccess(outcome)) throw new Error("expected the work to fail");

  return outcome.failure instanceof Error
    ? outcome.failure
    : new Error(String(outcome.failure), { cause: outcome.failure });
}

function migrationOf(failure: Error): string | undefined {
  return failure instanceof MigrationFailed ? failure.migration : undefined;
}

describe("migrate", () => {
  test("an empty file becomes the current schema, and migrating again is a no-op", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = absolutePath(join(directory, "janela.sqlite"));
      const { logger, records } = recordingLogger();
      const database = await openDatabase({ path, log: logger });

      await database.migrate();

      expect(tableNames(path)).toEqual([
        "AutomationScript",
        "Project",
        "Session",
        "Terminal",
        "_prisma_migrations",
      ]);

      const applied = migrationRows(path);

      expect(applied).toHaveLength(MIGRATIONS.length);
      expect(applied.map((row) => row.migration_name)).toEqual(
        MIGRATIONS.map((migration) => migration.name),
      );
      expect(applied.every((row) => row.finished_at !== null)).toBe(true);

      await database.migrate();

      expect(migrationRows(path)).toHaveLength(MIGRATIONS.length);
      expect(records.filter((record) => record.message === "migration applied")).toHaveLength(
        MIGRATIONS.length,
      );

      await database.close();
    });
  });

  test("MIGRATIONS is exactly what is on disk, by name and by text", async () => {
    const root = join(import.meta.dir, "../prisma/migrations");
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();

    expect(directories).toEqual(MIGRATIONS.map((migration) => migration.name));

    const texts = await Promise.all(
      MIGRATIONS.map((migration) => readFile(join(root, migration.name, "migration.sql"), "utf8")),
    );

    for (const [index, text] of texts.entries()) {
      expect(MIGRATIONS[index]?.sql).toBe(text);
    }
  });

  test("cascades are in the shipped SQL, because they are the product rules", () => {
    const initial = MIGRATIONS[0]?.sql ?? "";

    for (const constraint of [
      "Session_projectId_fkey",
      "Terminal_sessionId_fkey",
      "AutomationCommand_projectId_fkey",
    ]) {
      expect(initial).toContain(`CONSTRAINT "${constraint}"`);
    }

    expect(initial.match(/ON DELETE CASCADE/g)).toHaveLength(3);
    expect(initial.match(/ON DELETE SET NULL/g)).toHaveLength(2);

    const scripts = MIGRATIONS[1]?.sql ?? "";

    expect(scripts).toContain('CONSTRAINT "AutomationScript_projectId_fkey"');
    expect(scripts.match(/ON DELETE CASCADE/g)).toHaveLength(1);
  });

  test("argv rows at the first schema become one script per event, quoted and in order", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger } = recordingLogger();
      const first = MIGRATIONS[0];

      if (first === undefined) throw new Error("no initial migration");

      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      expect(await applyMigrations(connection, [first], logger)).toBe(1);

      const seed = new Database(path);
      seed.run(
        `INSERT INTO "Project" (id, name, directory, addedAt) VALUES ('p', 'janela', '/tmp/janela', 0)`,
      );
      seed.run(
        `INSERT INTO "AutomationCommand" (id, projectId, event, command, isEnabled, timeoutSeconds, position)
           VALUES ('a', 'p', 'worktreeCreated', '["cp",".env","it''s here"]', 1, 30, 1),
                  ('b', 'p', 'worktreeCreated', '["pnpm","install"]', 0, 30, 0),
                  ('c', 'p', 'sessionTeardown', '["docker","compose","down"]', 1, 12, 0),
                  ('d', 'p', 'sessionTeardown', '["make","clean"]', 1, 99, 1)`,
      );
      seed.close();

      expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(MIGRATIONS.length - 1);

      const rows = readOnly(path, (database) =>
        database
          .query<{ event: string; script: string; timeoutSeconds: number }, []>(
            `SELECT event, script, timeoutSeconds FROM "AutomationScript" ORDER BY event`,
          )
          .all(),
      );

      expect(rows).toEqual([
        {
          event: "sessionTeardown",
          script: "'docker' 'compose' 'down'\n'make' 'clean'",
          timeoutSeconds: 12,
        },
        {
          event: "worktreeCreated",
          script: "# 'pnpm' 'install'\n'cp' '.env' 'it'\\''s here'",
          timeoutSeconds: 30,
        },
      ]);
      expect(tableNames(path)).not.toContain("AutomationCommand");

      await connection.dispose();
    });
  });

  test("a project at the second schema keeps its settings, and only loses the forge switch", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger } = recordingLogger();
      const priors = MIGRATIONS.slice(0, 2);

      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      expect(await applyMigrations(connection, priors, logger)).toBe(2);

      const seed = new Database(path);
      seed.run(
        `INSERT INTO "Project" (id, name, directory, worktreeRoot, worktreeRootPath, isForgeEnabled, accent, addedAt)
           VALUES ('p', 'janela', '/tmp/janela', 'custom', '/tmp/trees', 0, 'blue', 0)`,
      );
      seed.close();

      expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(MIGRATIONS.length - 2);

      const columns = readOnly(path, (database) =>
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('Project')`)
          .all()
          .map((column) => column.name),
      );
      const row = readOnly(path, (database) =>
        database
          .query<{ worktreeRoot: string; worktreeRootPath: string; accent: string }, []>(
            `SELECT worktreeRoot, worktreeRootPath, accent FROM "Project" WHERE id = 'p'`,
          )
          .get(),
      );

      expect(columns).not.toContain("isForgeEnabled");
      expect(row).toEqual({
        worktreeRoot: "custom",
        worktreeRootPath: "/tmp/trees",
        accent: "blue",
      });

      await connection.dispose();
    });
  });

  test("a project at the third schema loses its default profile and keeps every session", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger } = recordingLogger();
      const priors = MIGRATIONS.slice(0, 3);

      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      expect(await applyMigrations(connection, priors, logger)).toBe(3);

      const seed = new Database(path);
      seed.run(
        `INSERT INTO "LaunchProfile" (id, name, iconName, command, environment)
           VALUES ('lp', 'Claude Code', 'sparkles', '["claude"]', '{}')`,
      );
      seed.run(
        `INSERT INTO "Project" (id, name, directory, addedAt, defaultProfileId)
           VALUES ('p', 'janela', '/tmp/janela', 0, 'lp')`,
      );
      seed.run(
        `INSERT INTO "Session" (id, projectId, name, directory, backingKind, layout, position, createdAt, lastActiveAt)
           VALUES ('s', 'p', 'feature', '/tmp/janela', 'projectDirectory', '{}', 0, 0, 0)`,
      );
      seed.close();

      expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(MIGRATIONS.length - 3);

      const columns = readOnly(path, (database) =>
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('Project')`)
          .all()
          .map((column) => column.name),
      );
      const sessions = readOnly(path, (database) =>
        database
          .query<{ id: string; projectId: string }, []>(`SELECT id, projectId FROM "Session"`)
          .all(),
      );
      const foreignKeys = await connection.queryRaw({
        sql: "PRAGMA foreign_keys",
        args: [],
        argTypes: [],
      });

      expect(columns).not.toContain("defaultProfileId");
      expect(columns).toContain("directory");
      expect(sessions).toEqual([{ id: "s", projectId: "p" }]);
      expect(foreignKeys.rows).toEqual([[1]]);

      await connection.dispose();
    });
  });

  test("a terminal at the fourth schema keeps its session and loses the profile it named", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger } = recordingLogger();
      const priors = MIGRATIONS.slice(0, 4);

      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      expect(await applyMigrations(connection, priors, logger)).toBe(4);

      const seed = new Database(path);
      seed.run(
        `INSERT INTO "LaunchProfile" (id, name, iconName, command, environment)
           VALUES ('lp', 'Claude Code', 'sparkles', '["claude"]', '{}')`,
      );
      seed.run(
        `INSERT INTO "Session" (id, name, directory, backingKind, layout, position, createdAt, lastActiveAt)
           VALUES ('s', 'feature', '/tmp/janela', 'folder', '{}', 0, 0, 0)`,
      );
      seed.run(
        `INSERT INTO "Terminal" (id, sessionId, title, startsAutomatically, role, position, createdAt, profileId)
           VALUES ('t', 's', 'claude', 1, 'user', 0, 0, 'lp')`,
      );
      seed.close();

      expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(MIGRATIONS.length - 4);

      const columns = readOnly(path, (database) =>
        database
          .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('Terminal')`)
          .all()
          .map((column) => column.name),
      );
      const terminals = readOnly(path, (database) =>
        database
          .query<{ id: string; sessionId: string; title: string }, []>(
            `SELECT id, sessionId, title FROM "Terminal"`,
          )
          .all(),
      );
      const indexes = readOnly(path, (database) =>
        database
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Terminal'`,
          )
          .all()
          .map((index) => index.name),
      );
      const foreignKeys = await connection.queryRaw({
        sql: "PRAGMA foreign_keys",
        args: [],
        argTypes: [],
      });

      expect(tableNames(path)).not.toContain("LaunchProfile");
      expect(columns).not.toContain("profileId");
      expect(columns).toContain("title");
      expect(terminals).toEqual([{ id: "t", sessionId: "s", title: "claude" }]);
      expect(indexes).toContain("Terminal_sessionId_position_idx");
      expect(foreignKeys.rows).toEqual([[1]]);

      await connection.dispose();
    });
  });

  test("an edited shipped migration is refused rather than re-run", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const name = MIGRATIONS[0]?.name ?? "";
      const seed = new Database(path);

      seed.run(MIGRATIONS_TABLE_DDL);
      seed.run(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ('seeded', '0', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
        [name],
      );
      seed.close();

      const database = await openDatabase({ path: absolutePath(path) });
      const failure = await failureOf(database.migrate());

      expect(failure).toBeInstanceOf(MigrationFailed);
      expect(migrationOf(failure)).toBe(name);
      expect(tableNames(path)).toEqual(["_prisma_migrations"]);

      await database.close();
    });
  });

  test("a failing migration rolls back and leaves no bookkeeping row", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger, records } = recordingLogger();
      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      const failure = await failureOf(
        applyMigrations(
          connection,
          [{ name: "broken", sql: "CREATE TABLE Half (x TEXT); CREATE TABLE (" }],
          logger,
        ),
      );

      expect(failure).toBeInstanceOf(MigrationFailed);
      expect(migrationOf(failure)).toBe("broken");
      expect(await tablesVisibleTo(connection)).toEqual(["_prisma_migrations"]);
      expect(migrationRows(path)).toHaveLength(0);
      expect(records.filter((record) => record.message === "migration applied")).toHaveLength(0);
      expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(MIGRATIONS.length);
      expect(tableNames(path)).toContain("Session");

      await connection.dispose();
    });
  });

  test("opening creates the parent directory, because a first launch has none", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = absolutePath(join(directory, "Application Support", "Janela", "janela.sqlite"));
      const database = await openDatabase({ path });

      await database.migrate();

      expect(tableNames(path)).toContain("Session");

      await database.close();
    });
  });

  test("the default path is the daemon-private store in Application Support", () => {
    expect(defaultDatabasePath()).toEndWith(
      "/Library/Application Support/sh.janela.Janela/janela.sqlite",
    );
  });
});
