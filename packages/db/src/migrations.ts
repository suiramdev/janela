/**
 * Applying migrations without Prisma's CLI.
 *
 * `prisma migrate deploy` needs Node, the `prisma` package and the `prisma/`
 * directory. `janelad` ships as one compiled file and has none of the three, so
 * the migrations travel *inside* it: each one is a text import (see
 * `migrations.d.ts`), and this module applies the pending ones in order.
 *
 * The bookkeeping table is Prisma's own `_prisma_migrations`, with Prisma's own
 * column set and Prisma's own checksum (sha256-hex of the raw SQL text). That is
 * the point: a database migrated by the daemon must be one `prisma migrate dev`
 * can carry forward on a developer's machine, and vice versa. There is a test for
 * exactly that round trip.
 *
 * Not exported from the package: the daemon calls `JanelaDatabase.migrate()`,
 * which is the only entry point anyone above needs.
 */

import { createHash } from "node:crypto";

import type { Logger } from "@janela/support";
import type { SqlDriverAdapter, SqlQuery } from "@prisma/driver-adapter-utils";

import initial from "../prisma/migrations/20260908180902_initial/migration.sql" with { type: "text" };
import { MigrationFailed } from "./errors.ts";

export interface Migration {
  /** The directory name under `prisma/migrations`, exactly. */
  readonly name: string;
  readonly sql: string;
}

/**
 * Every migration, in order.
 *
 * **Each directory under `prisma/migrations` has exactly one entry here, by its
 * exact name.** A new directory without an entry is a database that never gets
 * migrated in the shipped daemon while working perfectly under `bun run`; the
 * disk-parity test in `migrations.test.ts` is what stops that reaching a user.
 */
export const MIGRATIONS: readonly Migration[] = [{ name: "20260908180902_initial", sql: initial }];

/**
 * Prisma's own table, verbatim from its schema engine, so the CLI recognises what
 * the daemon wrote. Do not tidy the alignment — matching Prisma's DDL is the
 * whole value of this constant.
 */
export const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
);`;

/** A query in the shape the Prisma runtime sends; every argument here is a string. */
function textQuery(sql: string, args: readonly string[]): SqlQuery {
  return {
    sql,
    args: [...args],
    argTypes: args.map(() => ({ scalarType: "string", arity: "scalar" })),
  };
}

interface AppliedRow {
  readonly checksum: string;
  readonly isFinished: boolean;
}

async function appliedMigrations(connection: SqlDriverAdapter): Promise<Map<string, AppliedRow>> {
  const { rows } = await connection.queryRaw(
    textQuery(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      [],
    ),
  );

  const applied = new Map<string, AppliedRow>();
  for (const row of rows) {
    const [name, checksum, finishedAt, rolledBackAt] = row;
    if (typeof name !== "string" || typeof checksum !== "string") continue;
    applied.set(name, {
      checksum,
      // An unfinished or rolled-back row describes an attempt, not a schema. It
      // is treated as pending, which is what `prisma migrate deploy` does too.
      isFinished:
        finishedAt !== null &&
        finishedAt !== undefined &&
        (rolledBackAt === null || rolledBackAt === undefined),
    });
  }
  return applied;
}

/**
 * Applies the pending migrations in order, returning how many ran.
 *
 * Each one runs in its own transaction, so a failure leaves the database at the
 * last complete version rather than half-way through a schema change — SQLite
 * makes DDL transactional, which is the reason this is possible at all.
 *
 * No pragmas are set here: the adapter applied them on connect (ADR 0019).
 */
export async function applyMigrations(
  connection: SqlDriverAdapter,
  migrations: readonly Migration[],
  log: Logger,
): Promise<number> {
  await connection.executeScript(MIGRATIONS_TABLE_DDL);
  const applied = await appliedMigrations(connection);
  let count = 0;

  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const already = applied.get(migration.name);

    if (already?.isFinished === true) {
      if (already.checksum !== checksum) {
        // "Never edit a shipped migration" is enforced here rather than by
        // review: a user's database is already at this version, so rewriting it
        // does nothing for them and silently diverges everyone else.
        throw new MigrationFailed(
          migration.name,
          new Error("checksum differs from the shipped migration"),
        );
      }
      continue;
    }

    // Strictly sequential, and that is the entire contract: migration N+1 is
    // written against the schema N left behind, and they share one connection.
    // oxlint-disable-next-line no-await-in-loop
    await apply(connection, migration, checksum, log);
    count += 1;
  }

  return count;
}

async function apply(
  connection: SqlDriverAdapter,
  migration: Migration,
  checksum: string,
  log: Logger,
): Promise<void> {
  const transaction = await connection.startTransaction();
  const id = crypto.randomUUID();

  try {
    await transaction.executeRaw(
      textQuery(
        `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [id, checksum, migration.name],
      ),
    );
    // Deliberately the *connection* and not the transaction: `executeScript` is
    // only on the connection, and both run on the one SQLite handle this adapter
    // holds — so the script executes inside the transaction opened above.
    await connection.executeScript(migration.sql);
    await transaction.executeRaw(
      textQuery(
        `UPDATE "_prisma_migrations"
         SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1
         WHERE id = ?`,
        [id],
      ),
    );
    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // The transaction is already gone, or the connection is. Either way the
      // failure worth reporting is the one that got us here.
    }
    throw new MigrationFailed(migration.name, error);
  }

  log.info("migration applied", { migration: migration.name });
}
