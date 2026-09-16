import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ColumnTypeEnum, DriverAdapterError } from "@prisma/driver-adapter-utils";
import type {
  ArgScalarType,
  Error as AdapterError,
  SqlDriverAdapter,
  SqlQuery,
  SqlResultSet,
} from "@prisma/driver-adapter-utils";
import { Effect, Predicate, Result, Schema } from "effect";

import { janelaSqliteAdapter } from "./adapter.ts";

interface AdapterUnderTest {
  readonly path?: string;
  readonly pragmas?: Readonly<Record<string, string>>;
}

interface AdapterRequest {
  path: string;
  pragmas?: Readonly<Record<string, string>>;
}

const TYPED_TABLE = `CREATE TABLE t (
  s TEXT, i INTEGER, r REAL, b BLOB, d DATETIME,
  v VARCHAR(20), bo BOOLEAN, n DECIMAL, big BIGINT
);`;

const ROWS = `CREATE TABLE r (id TEXT PRIMARY KEY);`;

const decodePragmaValue = Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Number]));

async function open(
  schema: string | undefined,
  options: AdapterUnderTest = {},
): Promise<SqlDriverAdapter> {
  const request: AdapterRequest = { path: options.path ?? ":memory:" };

  if (options.pragmas !== undefined) request.pragmas = options.pragmas;

  const adapter = await janelaSqliteAdapter(request).connect();

  if (schema !== undefined) await adapter.executeScript(schema);

  return adapter;
}

function withAdapter<T>(
  schema: string | undefined,
  work: (adapter: SqlDriverAdapter) => Promise<T>,
  options: AdapterUnderTest = {},
): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* Effect.acquireRelease(
          Effect.promise(() => open(schema, options)),
          (connected) => Effect.promise(() => connected.dispose()),
        );

        return yield* Effect.tryPromise({
          try: () => work(adapter),
          catch: (cause: unknown) => cause,
        });
      }),
    ),
  );
}

function q(sql: string, args: unknown[] = [], scalarTypes: ArgScalarType[] = []): SqlQuery {
  return {
    sql,
    args,
    argTypes: args.map((_, index) => ({
      scalarType: scalarTypes[index] ?? "unknown",
      arity: "scalar",
    })),
  };
}

async function failureOf(work: Promise<unknown>): Promise<AdapterError> {
  const outcome = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: () => work, catch: (cause: unknown) => cause })),
  );

  if (Result.isSuccess(outcome)) throw new Error("expected the query to fail");

  const { failure } = outcome;

  expect(failure).toBeInstanceOf(DriverAdapterError);

  if (!(failure instanceof DriverAdapterError)) throw new Error("not a DriverAdapterError");

  expect(failure.name).toBe("DriverAdapterError");

  return failure.cause;
}

async function pragma(adapter: SqlDriverAdapter, name: string): Promise<string | number> {
  const { rows } = await adapter.queryRaw(q(`PRAGMA ${name}`));

  return decodePragmaValue(rows[0]?.[0]);
}

function withTemporaryDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "janela-db-"))),
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

describe("column types", () => {
  test("a declared type decides the column, whatever the stored value looks like", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      await adapter.executeRaw(
        q(
          `INSERT INTO t VALUES (42, 1.5, 2.5, X'0102', '2020-01-01T00:00:00+00:00', 'x', 1, 1.5, 5)`,
        ),
      );

      const result = await adapter.queryRaw(q(`SELECT * FROM t`));

      expect(result.columnTypes).toEqual([
        ColumnTypeEnum.Text,
        ColumnTypeEnum.Int32,
        ColumnTypeEnum.Double,
        ColumnTypeEnum.Bytes,
        ColumnTypeEnum.DateTime,
        ColumnTypeEnum.Text,
        ColumnTypeEnum.Boolean,
        ColumnTypeEnum.Numeric,
        ColumnTypeEnum.Int64,
      ]);
      expect(result.rows).toEqual([
        ["42", 1, 2.5, new Uint8Array([1, 2]), "2020-01-01T00:00:00+00:00", "x", 1, 1.5, 5],
      ]);
    });
  });

  test("an undeclared column is typed from the first value that is not null", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      await adapter.executeRaw(q(`INSERT INTO t (s) VALUES ('one')`));

      const result = await adapter.queryRaw(
        q(`SELECT count(*) AS c, length('bun') AS l, 1.5 AS f, 'x' AS s, X'0102' AS b FROM t`),
      );

      expect(result.columnTypes).toEqual([
        ColumnTypeEnum.Int64,
        ColumnTypeEnum.Int64,
        ColumnTypeEnum.Double,
        ColumnTypeEnum.Text,
        ColumnTypeEnum.Bytes,
      ]);
      expect(result.rows).toEqual([[1, 3, 1.5, "x", new Uint8Array([1, 2])]]);
    });
  });

  test("a leading null does not decide an undeclared column", async () => {
    await withAdapter(`CREATE TABLE u (v);`, async (adapter) => {
      await adapter.executeRaw(q(`INSERT INTO u VALUES (NULL), ('later')`));

      const result = await adapter.queryRaw(q(`SELECT v FROM u ORDER BY rowid`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.Text]);
      expect(result.rows).toEqual([[null], ["later"]]);
    });
  });

  test("an all-null undeclared column falls back to Int32, which decodes null under any type", async () => {
    await withAdapter(undefined, async (adapter) => {
      const result = await adapter.queryRaw(q(`SELECT NULL AS z`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.Int32]);
      expect(result.rows).toEqual([[null]]);
    });
  });

  test("a null value keeps its declared type", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      await adapter.executeRaw(q(`INSERT INTO t (d) VALUES (NULL)`));

      const result = await adapter.queryRaw(q(`SELECT d FROM t`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.DateTime]);
      expect(result.rows).toEqual([[null]]);
    });
  });

  test("an integer never leaves as a bigint, because the runtime refuses to decode one", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      await adapter.executeRaw(q(`INSERT INTO t (i) VALUES (42), (9223372036854775807)`));

      const { rows } = await adapter.queryRaw(q(`SELECT i FROM t ORDER BY i`));

      expect(rows).toEqual([[42], ["9223372036854775807"]]);
      expect(Predicate.isNumber(rows[0]?.[0])).toBe(true);
    });
  });

  test("a DATETIME comes back as an ISO string whether it was stored as text or epoch millis", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      await adapter.executeRaw(
        q(`INSERT INTO t (s, d) VALUES ('text', '2020-01-01T00:00:00+00:00'), ('epoch', 0)`),
      );

      const { rows } = await adapter.queryRaw(q(`SELECT d FROM t ORDER BY s`));

      expect(rows).toEqual([["1970-01-01T00:00:00.000Z"], ["2020-01-01T00:00:00+00:00"]]);
    });
  });

  test("an empty result set still carries its names and declared types", async () => {
    await withAdapter(TYPED_TABLE, async (adapter) => {
      const result = await adapter.queryRaw(q(`SELECT s, i FROM t WHERE 0`));

      expect(result.columnNames).toEqual(["s", "i"]);
      expect(result.columnTypes).toEqual([ColumnTypeEnum.Text, ColumnTypeEnum.Int32]);
      expect(result.rows).toEqual([]);
    });
  });

  test("duplicate column names never misalign the values they belong to", async () => {
    await withAdapter(
      `CREATE TABLE a (id TEXT PRIMARY KEY, x TEXT); CREATE TABLE b (id TEXT PRIMARY KEY);`,
      async (adapter) => {
        await adapter.executeScript(
          `INSERT INTO a VALUES ('a1', 'ax'); INSERT INTO b VALUES ('b1');`,
        );

        const outcome: SqlResultSet | DriverAdapterError = await adapter
          .queryRaw(q(`SELECT a.id, b.id, a.x FROM a JOIN b`))
          .catch((cause: unknown) => {
            expect(cause).toBeInstanceOf(DriverAdapterError);

            if (!(cause instanceof DriverAdapterError)) throw new Error("not an adapter error");

            return cause;
          });

        if (outcome instanceof DriverAdapterError) {
          expect(outcome.cause.kind).toBe("InconsistentColumnData");
        } else {
          expect(outcome.columnNames).toEqual(["id", "id", "x"]);
          expect(outcome.rows).toEqual([["a1", "b1", "ax"]]);
        }

        const aliased = await adapter.queryRaw(
          q(`SELECT a.id AS aid, b.id AS bid, a.x FROM a JOIN b`),
        );

        expect(aliased.columnNames).toEqual(["aid", "bid", "x"]);
        expect(aliased.rows).toEqual([["a1", "b1", "ax"]]);
      },
    );
  });
});

describe("arguments", () => {
  test("bindings are coerced the way the runtime sends them", async () => {
    await withAdapter(
      `CREATE TABLE v (bo BOOLEAN, i INTEGER, d DATETIME, b BLOB, s TEXT);`,
      async (adapter) => {
        const affected = await adapter.executeRaw(
          q(
            `INSERT INTO v VALUES (?, ?, ?, ?, ?)`,
            [true, "7", "2020-01-01T00:00:00.000Z", "AQI=", null],
            ["boolean", "int", "datetime", "bytes", "string"],
          ),
        );

        expect(affected).toBe(1);

        const { rows } = await adapter.queryRaw(q(`SELECT bo, i, d, b, s FROM v`));

        expect(rows).toEqual([
          [1, 7, "2020-01-01T00:00:00.000+00:00", new Uint8Array([1, 2]), null],
        ]);
      },
    );
  });

  test("a Date argument is written in the encoding SQLite's date functions accept", async () => {
    await withAdapter(`CREATE TABLE w (d DATETIME);`, async (adapter) => {
      await adapter.executeRaw(
        q(`INSERT INTO w VALUES (?)`, [new Date("2026-01-02T03:04:05.678Z")]),
      );

      const { rows } = await adapter.queryRaw(q(`SELECT d, strftime('%Y', d) AS year FROM w`));

      expect(rows).toEqual([["2026-01-02T03:04:05.678+00:00", "2026"]]);
    });
  });
});

describe("executeRaw", () => {
  test("reports the number of rows the statement affected", async () => {
    await withAdapter(`CREATE TABLE x (id INTEGER PRIMARY KEY, n TEXT);`, async (adapter) => {
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [1], ["int"]))).toBe(1);
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [2], ["int"]))).toBe(1);
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [3], ["int"]))).toBe(1);
      expect(await adapter.executeRaw(q(`UPDATE x SET n = 'b'`))).toBe(3);
      expect(await adapter.executeRaw(q(`UPDATE x SET n = 'c' WHERE 0`))).toBe(0);
    });
  });
});

describe("transactions", () => {
  test("a commit persists, and the finished transaction refuses further work", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const transaction = await adapter.startTransaction();

      await transaction.executeRaw(q(`INSERT INTO r VALUES ('one')`));
      await transaction.commit();

      const { rows } = await adapter.queryRaw(q(`SELECT id FROM r`));

      expect(rows).toEqual([["one"]]);

      const failure = await failureOf(transaction.executeRaw(q(`INSERT INTO r VALUES ('two')`)));

      expect(failure.kind).toBe("TransactionAlreadyClosed");

      await transaction.commit();
    });
  });

  test("a rollback discards everything the transaction wrote", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const transaction = await adapter.startTransaction();

      await transaction.executeRaw(q(`INSERT INTO r VALUES ('one')`));
      await transaction.rollback();

      const { rows } = await adapter.queryRaw(q(`SELECT id FROM r`));

      expect(rows).toEqual([]);

      await transaction.rollback();
    });
  });

  test("a second transaction waits, because one connection holds one transaction", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const first = await adapter.startTransaction();
      const order: string[] = [];
      const pending = adapter.startTransaction().then((transaction) => {
        order.push("second began");

        return transaction;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(order).toEqual([]);

      order.push("first committed");

      await first.commit();

      const second = await pending;

      expect(order).toEqual(["first committed", "second began"]);

      await second.executeRaw(q(`INSERT INTO r VALUES ('two')`));
      await second.commit();

      expect(await adapter.queryRaw(q(`SELECT id FROM r`))).toMatchObject({ rows: [["two"]] });
    });
  });

  test("only SERIALIZABLE is accepted, because that is what one SQLite writer gives", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const failure = await failureOf(adapter.startTransaction("READ COMMITTED"));

      expect(failure).toMatchObject({ kind: "InvalidIsolationLevel", level: "READ COMMITTED" });

      const transaction = await adapter.startTransaction("SERIALIZABLE");

      await transaction.commit();
    });
  });

  test("savepoints scope a rollback, which is what a nested $transaction needs", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const transaction = await adapter.startTransaction();
      const { createSavepoint, rollbackToSavepoint, releaseSavepoint } = transaction;

      if (
        createSavepoint === undefined ||
        rollbackToSavepoint === undefined ||
        releaseSavepoint === undefined
      ) {
        throw new Error("the adapter must implement savepoints, or a nested $transaction fails");
      }

      await transaction.executeRaw(q(`INSERT INTO r VALUES ('kept')`));
      await createSavepoint.call(transaction, "sp1");
      await transaction.executeRaw(q(`INSERT INTO r VALUES ('dropped')`));
      await rollbackToSavepoint.call(transaction, "sp1");
      await releaseSavepoint.call(transaction, "sp1");
      await transaction.commit();

      const { rows } = await adapter.queryRaw(q(`SELECT id FROM r`));

      expect(rows).toEqual([["kept"]]);
    });
  });
});

describe("open", () => {
  test("the pragmas are applied, and an override replaces just its own default", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");

      await withAdapter(
        undefined,
        async (adapter) => {
          expect(await pragma(adapter, "journal_mode")).toBe("wal");
          expect(await pragma(adapter, "synchronous")).toBe(1);
          expect(await pragma(adapter, "foreign_keys")).toBe(1);
          expect(await pragma(adapter, "busy_timeout")).toBe(2000);
        },
        { path },
      );

      await withAdapter(
        undefined,
        async (overridden) => {
          expect(await pragma(overridden, "synchronous")).toBe(2);
          expect(await pragma(overridden, "journal_mode")).toBe("wal");
          expect(await pragma(overridden, "busy_timeout")).toBe(2000);
        },
        { path, pragmas: { synchronous: "FULL" } },
      );
    });
  });

  test("foreign keys are enforced, because the cascade rules are the product rules", async () => {
    await withAdapter(
      `CREATE TABLE p (id TEXT PRIMARY KEY);
       CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE);`,
      async (adapter) => {
        const failure = await failureOf(
          adapter.executeRaw(q(`INSERT INTO c VALUES ('c1', 'missing')`)),
        );

        expect(failure.kind).toBe("ForeignKeyConstraintViolation");

        await adapter.executeScript(
          `INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');`,
        );
        await adapter.executeRaw(q(`DELETE FROM p WHERE id = 'p1'`));

        expect(await adapter.queryRaw(q(`SELECT count(*) FROM c`))).toMatchObject({ rows: [[0]] });
      },
    );
  });

  test("an unopenable path rejects instead of throwing synchronously", async () => {
    await withTemporaryDirectory(async (directory) => {
      const factory = janelaSqliteAdapter({ path: join(directory, "missing", "janela.sqlite") });
      const failure = await failureOf(factory.connect());

      expect(failure).toMatchObject({ kind: "sqlite", originalCode: "SQLITE_CANTOPEN" });
    });
  });

  test("a pragma that is not a bare name is refused rather than interpolated", async () => {
    const failure = await failureOf(
      janelaSqliteAdapter({
        path: ":memory:",
        pragmas: { "journal_mode = WAL; DROP TABLE t": "x" },
      }).connect(),
    );

    expect(failure.kind).toBe("InvalidInputValue");
  });
});

describe("errors", () => {
  test("a constraint violation names the fields Prisma reports", async () => {
    await withAdapter(
      `CREATE TABLE p (id TEXT PRIMARY KEY);
       CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT NOT NULL);`,
      async (adapter) => {
        await adapter.executeRaw(q(`INSERT INTO p VALUES ('p1')`));

        expect(await failureOf(adapter.executeRaw(q(`INSERT INTO p VALUES ('p1')`)))).toMatchObject(
          { kind: "UniqueConstraintViolation", constraint: { fields: ["id"] } },
        );
        expect(
          await failureOf(adapter.executeRaw(q(`INSERT INTO c VALUES ('c1', NULL)`))),
        ).toMatchObject({ kind: "NullConstraintViolation", constraint: { fields: ["pid"] } });
      },
    );
  });

  test("a missing table and a missing column are named", async () => {
    await withAdapter(ROWS, async (adapter) => {
      expect(await failureOf(adapter.queryRaw(q(`SELECT * FROM nope`)))).toMatchObject({
        kind: "TableDoesNotExist",
        table: "nope",
      });
      expect(await failureOf(adapter.queryRaw(q(`SELECT nope FROM r`)))).toMatchObject({
        kind: "ColumnNotFound",
        column: "nope",
      });
      expect(
        await failureOf(adapter.executeRaw(q(`INSERT INTO r (nope) VALUES ('x')`))),
      ).toMatchObject({ kind: "ColumnNotFound", column: "nope" });
    });
  });

  test("the original SQLite message and code survive for the log", async () => {
    await withAdapter(ROWS, async (adapter) => {
      const failure = await failureOf(adapter.executeRaw(q(`INSERT INTO r VALUES (1), (1)`)));

      expect(failure.originalMessage).toBe("UNIQUE constraint failed: r.id");
      expect(failure.originalCode).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    });
  });
});

describe("dispose", () => {
  test("closes the connection, and stays closed", async () => {
    const adapter = await open(ROWS);

    await adapter.dispose();

    const failure = await failureOf(adapter.queryRaw(q(`SELECT id FROM r`)));

    expect(failure.originalMessage).toContain("closed");

    await adapter.dispose();
  });
});
