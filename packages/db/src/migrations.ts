import { createHash } from "node:crypto";

import type { Logger } from "@janela/support";
import type { SqlDriverAdapter, SqlQuery } from "@prisma/driver-adapter-utils";
import { Effect, Exit, Option, Schema } from "effect";

import initial from "../prisma/migrations/20260908180902_initial/migration.sql" with { type: "text" };
import automationScripts from "../prisma/migrations/20260917120000_automation_scripts/migration.sql" with { type: "text" };
import { MigrationFailed } from "./errors.ts";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

interface AppliedRow {
  readonly checksum: string;
  readonly isFinished: boolean;
}

export const MIGRATIONS: readonly Migration[] = [
  { name: "20260908180902_initial", sql: initial },
  { name: "20260917120000_automation_scripts", sql: automationScripts },
];

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

const BookkeepingTimestamp = Schema.UndefinedOr(Schema.NullOr(Schema.String));

const BookkeepingRow = Schema.Tuple([
  Schema.String,
  Schema.String,
  BookkeepingTimestamp,
  BookkeepingTimestamp,
]);

const decodeBookkeepingRow = Schema.decodeUnknownOption(BookkeepingRow);

const SELECT_APPLIED = `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`;

const START_MIGRATION = `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`;

const FINISH_MIGRATION = `UPDATE "_prisma_migrations"
         SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1
         WHERE id = ?`;

function textQuery(sql: string, args: readonly string[]): SqlQuery {
  return {
    sql,
    args: [...args],
    argTypes: args.map(() => ({ scalarType: "string", arity: "scalar" })),
  };
}

async function appliedMigrations(connection: SqlDriverAdapter): Promise<Map<string, AppliedRow>> {
  const { rows } = await connection.queryRaw(textQuery(SELECT_APPLIED, []));
  const applied = new Map<string, AppliedRow>();

  for (const row of rows) {
    const decoded = decodeBookkeepingRow(row);

    if (Option.isNone(decoded)) continue;

    const [name, checksum, finishedAt, rolledBackAt] = decoded.value;
    const finished = Option.fromNullishOr(finishedAt);
    const rolledBack = Option.fromNullishOr(rolledBackAt);

    applied.set(name, {
      checksum,
      isFinished: Option.isSome(finished) && Option.isNone(rolledBack),
    });
  }

  return applied;
}

function apply(
  connection: SqlDriverAdapter,
  migration: Migration,
  checksum: string,
  log: Logger,
): Promise<void> {
  const failed = (cause: unknown): MigrationFailed => new MigrationFailed(migration.name, cause);

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transaction = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => connection.startTransaction(),
            catch: (cause: unknown) => cause,
          }),
          (open, exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.tryPromise({ try: () => open.rollback(), catch: failed }).pipe(
                  Effect.catch(() =>
                    Effect.sync(() => {
                      log.warning("migration rollback failed", { migration: migration.name });
                    }),
                  ),
                ),
        );
        const id = crypto.randomUUID();

        yield* Effect.tryPromise({
          try: () =>
            transaction.executeRaw(textQuery(START_MIGRATION, [id, checksum, migration.name])),
          catch: failed,
        });
        yield* Effect.tryPromise({
          try: () => connection.executeScript(migration.sql),
          catch: failed,
        });
        yield* Effect.tryPromise({
          try: () => transaction.executeRaw(textQuery(FINISH_MIGRATION, [id])),
          catch: failed,
        });
        yield* Effect.tryPromise({ try: () => transaction.commit(), catch: failed });

        log.info("migration applied", { migration: migration.name });
      }),
    ),
  );
}

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
        throw new MigrationFailed(
          migration.name,
          new Error("checksum differs from the shipped migration"),
        );
      }

      continue;
    }

    // oxlint-disable-next-line no-await-in-loop
    await apply(connection, migration, checksum, log);
    count += 1;
  }

  return count;
}
