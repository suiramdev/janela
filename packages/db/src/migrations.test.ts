import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { absolutePath } from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import type { SqlDriverAdapter } from "@prisma/driver-adapter-utils";

import { janelaSqliteAdapter } from "./adapter.ts";
import { defaultDatabasePath, openDatabase } from "./database.ts";
import { MigrationFailed } from "./errors.ts";
import { MIGRATIONS, MIGRATIONS_TABLE_DDL, applyMigrations } from "./migrations.ts";

interface Record_ {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

/**
 * A structural fake. `@janela/test-support`'s recording sink is global and
 * unimplemented; the logger here is injected, so a local fake is enough.
 */
function recordingLogger(): { logger: Logger; records: Record_[] } {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
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

async function withTemporaryDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "janela-migrations-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Every table a user's database should have, ignoring SQLite's own bookkeeping. */
function tableNames(path: string): string[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

const TABLE_QUERY = `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;

/**
 * The same question, asked through the connection under test rather than a second
 * handle — so an uncommitted `CREATE TABLE` is visible if one was left open.
 */
async function tablesVisibleTo(connection: SqlDriverAdapter): Promise<string[]> {
  const { rows } = await connection.queryRaw({ sql: TABLE_QUERY, args: [], argTypes: [] });
  return rows.map((row) => String(row[0]));
}

interface MigrationRow {
  readonly migration_name: string;
  readonly checksum: string;
  readonly finished_at: string | null;
}

function migrationRows(path: string): MigrationRow[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .query<MigrationRow, []>(
        `SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY started_at`,
      )
      .all();
  } finally {
    database.close();
  }
}

describe("migrate", () => {
  test("an empty file becomes the current schema, and migrating again is a no-op", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = absolutePath(join(directory, "janela.sqlite"));
      const { logger, records } = recordingLogger();
      const database = await openDatabase({ path, log: logger });

      try {
        // Before: the adapter created the file, and nothing put a table in it.
        // For v1 this *is* the "migrate forward from the previous version" case:
        // the previous version is an empty database.
        await database.migrate();

        expect(tableNames(path)).toEqual([
          "AutomationCommand",
          "LaunchProfile",
          "Project",
          "Session",
          "Terminal",
          "_prisma_migrations",
        ]);

        const applied = migrationRows(path);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.migration_name).toBe(MIGRATIONS[0]?.name);
        expect(applied[0]?.finished_at).not.toBeNull();

        await database.migrate();
        expect(migrationRows(path)).toHaveLength(1);
        expect(records.filter((record) => record.message === "migration applied")).toHaveLength(1);
      } finally {
        await database.close();
      }
    });
  });

  test("MIGRATIONS is exactly what is on disk, by name and by text", async () => {
    const root = join(import.meta.dir, "../prisma/migrations");
    const entries = await readdir(root, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();

    // A new migration directory with no entry in `MIGRATIONS` is a database that
    // works under `bun run` and never migrates in the shipped daemon.
    expect(directories).toEqual(MIGRATIONS.map((migration) => migration.name));

    const texts = await Promise.all(
      MIGRATIONS.map((migration) => readFile(join(root, migration.name, "migration.sql"), "utf8")),
    );
    for (const [index, text] of texts.entries()) {
      expect(MIGRATIONS[index]?.sql).toBe(text);
    }
  });

  test("cascades are in the shipped SQL, because they are the product rules", async () => {
    const sql = MIGRATIONS[0]?.sql ?? "";
    for (const constraint of [
      "Session_projectId_fkey",
      "Terminal_sessionId_fkey",
      "AutomationCommand_projectId_fkey",
    ]) {
      expect(sql).toContain(`CONSTRAINT "${constraint}"`);
    }
    // Deleting a project takes its sessions with it; removing a profile leaves
    // the terminals that used it alone.
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(3);
    expect(sql.match(/ON DELETE SET NULL/g)).toHaveLength(2);
  });

  test("an edited shipped migration is refused rather than re-run", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const name = MIGRATIONS[0]?.name ?? "";

      const seed = new Database(path);
      try {
        seed.run(MIGRATIONS_TABLE_DDL);
        seed.run(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ('seeded', '0', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)`,
          [name],
        );
      } finally {
        seed.close();
      }

      const database = await openDatabase({ path: absolutePath(path) });
      try {
        const failure = await database.migrate().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(MigrationFailed);
        expect(failure instanceof MigrationFailed ? failure.migration : undefined).toBe(name);
        // Refused, not silently re-applied over the top of the user's schema.
        expect(tableNames(path)).toEqual(["_prisma_migrations"]);
      } finally {
        await database.close();
      }
    });
  });

  test("a failing migration rolls back and leaves no bookkeeping row", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");
      const { logger, records } = recordingLogger();
      const connection: SqlDriverAdapter = await janelaSqliteAdapter({ path }).connect();

      try {
        const failure = await applyMigrations(
          connection,
          [{ name: "broken", sql: "CREATE TABLE Half (x TEXT); CREATE TABLE (" }],
          logger,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(MigrationFailed);
        expect(failure instanceof MigrationFailed ? failure.migration : undefined).toBe("broken");
        // Observed on the *same* connection, and that is the whole point: an
        // outside reader sees a rolled-back file either way, because SQLite
        // rolls an open transaction back when the handle closes. Only the
        // connection that opened it can tell whether we rolled back or merely
        // walked away holding the write lock.
        expect(await tablesVisibleTo(connection)).toEqual(["_prisma_migrations"]);
        expect(migrationRows(path)).toHaveLength(0);
        expect(records.filter((record) => record.message === "migration applied")).toHaveLength(0);

        // And the connection is still usable, which it would not be if the
        // transaction were left open: the adapter releases its transaction lock
        // in `commit`/`rollback` and nowhere else.
        expect(await applyMigrations(connection, MIGRATIONS, logger)).toBe(1);
        expect(tableNames(path)).toContain("Session");
      } finally {
        await connection.dispose();
      }
    });
  });

  test("opening creates the parent directory, because a first launch has none", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = absolutePath(join(directory, "Application Support", "Janela", "janela.sqlite"));
      const database = await openDatabase({ path });
      try {
        await database.migrate();
        expect(tableNames(path)).toContain("Session");
      } finally {
        await database.close();
      }
    });
  });

  test("the default path is the daemon-private store in Application Support", () => {
    expect(defaultDatabasePath()).toEndWith(
      "/Library/Application Support/sh.janela.Janela/janela.sqlite",
    );
  });
});
