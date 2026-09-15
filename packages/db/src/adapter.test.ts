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

import { janelaSqliteAdapter } from "./adapter.ts";

/** Every column of every SQLite type name the schema and Prisma's own tables use. */
const TYPED_TABLE = `CREATE TABLE t (
  s TEXT, i INTEGER, r REAL, b BLOB, d DATETIME,
  v VARCHAR(20), bo BOOLEAN, n DECIMAL, big BIGINT
);`;

async function open(
  schema?: string,
  options?: { readonly path?: string; readonly pragmas?: Readonly<Record<string, string>> },
): Promise<SqlDriverAdapter> {
  const adapter = await janelaSqliteAdapter({
    path: options?.path ?? ":memory:",
    ...(options?.pragmas === undefined ? {} : { pragmas: options.pragmas }),
  }).connect();
  if (schema !== undefined) {
    await adapter.executeScript(schema);
  }
  return adapter;
}

/** A query in the shape the Prisma runtime sends. `scalarTypes` positionally match `args`. */
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

/** The mapped payload Prisma reads off a failure — `kind` and whatever that kind carries. */
async function failureOf(work: Promise<unknown>): Promise<AdapterError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DriverAdapterError);
    if (!(error instanceof DriverAdapterError)) throw error;
    expect(error.name).toBe("DriverAdapterError");
    return error.cause;
  }
  throw new Error("expected the query to fail");
}

async function pragma(adapter: SqlDriverAdapter, name: string): Promise<unknown> {
  const { rows } = await adapter.queryRaw(q(`PRAGMA ${name}`));
  return rows[0]?.[0];
}

/** `temporaryDirectory` from @janela/test-support is still a seam; switch to it once it lands. */
async function withTemporaryDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "janela-db-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("column types", () => {
  test("a declared type decides the column, whatever the stored value looks like", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
      // `42` into TEXT and `1.5` into INTEGER: SQLite stores what it is given.
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
    } finally {
      await adapter.dispose();
    }
  });

  test("an undeclared column is typed from the first value that is not null", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
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
    } finally {
      await adapter.dispose();
    }
  });

  test("a leading null does not decide an undeclared column", async () => {
    const adapter = await open(`CREATE TABLE u (v);`);
    try {
      await adapter.executeRaw(q(`INSERT INTO u VALUES (NULL), ('later')`));

      const result = await adapter.queryRaw(q(`SELECT v FROM u ORDER BY rowid`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.Text]);
      expect(result.rows).toEqual([[null], ["later"]]);
    } finally {
      await adapter.dispose();
    }
  });

  test("an all-null undeclared column falls back to Int32, which decodes null under any type", async () => {
    const adapter = await open();
    try {
      const result = await adapter.queryRaw(q(`SELECT NULL AS z`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.Int32]);
      expect(result.rows).toEqual([[null]]);
    } finally {
      await adapter.dispose();
    }
  });

  test("a null value keeps its declared type", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
      await adapter.executeRaw(q(`INSERT INTO t (d) VALUES (NULL)`));

      const result = await adapter.queryRaw(q(`SELECT d FROM t`));

      expect(result.columnTypes).toEqual([ColumnTypeEnum.DateTime]);
      expect(result.rows).toEqual([[null]]);
    } finally {
      await adapter.dispose();
    }
  });

  test("an integer never leaves as a bigint, because the runtime refuses to decode one", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
      await adapter.executeRaw(q(`INSERT INTO t (i) VALUES (42), (9223372036854775807)`));

      const { rows } = await adapter.queryRaw(q(`SELECT i FROM t ORDER BY i`));

      expect(rows).toEqual([[42], ["9223372036854775807"]]);
      expect(typeof rows[0]?.[0]).toBe("number");
    } finally {
      await adapter.dispose();
    }
  });

  test("a DATETIME comes back as an ISO string whether it was stored as text or epoch millis", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
      await adapter.executeRaw(
        q(`INSERT INTO t (s, d) VALUES ('text', '2020-01-01T00:00:00+00:00'), ('epoch', 0)`),
      );

      const { rows } = await adapter.queryRaw(q(`SELECT d FROM t ORDER BY s`));

      expect(rows).toEqual([["1970-01-01T00:00:00.000Z"], ["2020-01-01T00:00:00+00:00"]]);
    } finally {
      await adapter.dispose();
    }
  });

  test("an empty result set still carries its names and declared types", async () => {
    const adapter = await open(TYPED_TABLE);
    try {
      const result = await adapter.queryRaw(q(`SELECT s, i FROM t WHERE 0`));

      expect(result.columnNames).toEqual(["s", "i"]);
      expect(result.columnTypes).toEqual([ColumnTypeEnum.Text, ColumnTypeEnum.Int32]);
      expect(result.rows).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  test("duplicate column names never misalign the values they belong to", async () => {
    const adapter = await open(
      `CREATE TABLE a (id TEXT PRIMARY KEY, x TEXT); CREATE TABLE b (id TEXT PRIMARY KEY);`,
    );
    try {
      await adapter.executeScript(
        `INSERT INTO a VALUES ('a1', 'ax'); INSERT INTO b VALUES ('b1');`,
      );

      // Which branch runs is bun's business: through 1.3 it collapsed same-named
      // columns in `columnNames` while `values()` kept every one, and later
      // versions report them all. Pinning the test to either behaviour makes a
      // bun upgrade look like a regression, so the claim is the invariant both
      // owe us — the names are never quietly shorter than the row.
      const outcome: SqlResultSet | DriverAdapterError = await adapter
        .queryRaw(q(`SELECT a.id, b.id, a.x FROM a JOIN b`))
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(DriverAdapterError);
          if (!(error instanceof DriverAdapterError)) throw error;
          return error;
        });

      if (outcome instanceof DriverAdapterError) {
        // The names came back short, and there is no telling which position lost
        // one. Refusing beats decoding a row against the wrong column.
        expect(outcome.cause.kind).toBe("InconsistentColumnData");
      } else {
        expect(outcome.columnNames).toEqual(["id", "id", "x"]);
        expect(outcome.rows).toEqual([["a1", "b1", "ax"]]);
      }

      // Aliasing lines them up on every version, and is what the refusal asks for.
      const aliased = await adapter.queryRaw(
        q(`SELECT a.id AS aid, b.id AS bid, a.x FROM a JOIN b`),
      );
      expect(aliased.columnNames).toEqual(["aid", "bid", "x"]);
      expect(aliased.rows).toEqual([["a1", "b1", "ax"]]);
    } finally {
      await adapter.dispose();
    }
  });
});

describe("arguments", () => {
  test("bindings are coerced the way the runtime sends them", async () => {
    const adapter = await open(
      `CREATE TABLE v (bo BOOLEAN, i INTEGER, d DATETIME, b BLOB, s TEXT);`,
    );
    try {
      const affected = await adapter.executeRaw(
        q(
          `INSERT INTO v VALUES (?, ?, ?, ?, ?)`,
          [true, "7", "2020-01-01T00:00:00.000Z", "AQI=", null],
          ["boolean", "int", "datetime", "bytes", "string"],
        ),
      );
      expect(affected).toBe(1);

      const { rows } = await adapter.queryRaw(q(`SELECT bo, i, d, b, s FROM v`));

      expect(rows).toEqual([[1, 7, "2020-01-01T00:00:00.000+00:00", new Uint8Array([1, 2]), null]]);
    } finally {
      await adapter.dispose();
    }
  });

  test("a Date argument is written in the encoding SQLite's date functions accept", async () => {
    const adapter = await open(`CREATE TABLE w (d DATETIME);`);
    try {
      await adapter.executeRaw(
        q(`INSERT INTO w VALUES (?)`, [new Date("2026-01-02T03:04:05.678Z")]),
      );

      const { rows } = await adapter.queryRaw(q(`SELECT d, strftime('%Y', d) AS year FROM w`));

      expect(rows).toEqual([["2026-01-02T03:04:05.678+00:00", "2026"]]);
    } finally {
      await adapter.dispose();
    }
  });
});

describe("executeRaw", () => {
  test("reports the number of rows the statement affected", async () => {
    const adapter = await open(`CREATE TABLE x (id INTEGER PRIMARY KEY, n TEXT);`);
    try {
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [1], ["int"]))).toBe(1);
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [2], ["int"]))).toBe(1);
      expect(await adapter.executeRaw(q(`INSERT INTO x VALUES (?, 'a')`, [3], ["int"]))).toBe(1);

      expect(await adapter.executeRaw(q(`UPDATE x SET n = 'b'`))).toBe(3);
      expect(await adapter.executeRaw(q(`UPDATE x SET n = 'c' WHERE 0`))).toBe(0);
    } finally {
      await adapter.dispose();
    }
  });
});

describe("transactions", () => {
  const ROWS = `CREATE TABLE r (id TEXT PRIMARY KEY);`;

  test("a commit persists, and the finished transaction refuses further work", async () => {
    const adapter = await open(ROWS);
    try {
      const transaction = await adapter.startTransaction();
      await transaction.executeRaw(q(`INSERT INTO r VALUES ('one')`));
      await transaction.commit();

      const { rows } = await adapter.queryRaw(q(`SELECT id FROM r`));
      expect(rows).toEqual([["one"]]);

      const failure = await failureOf(transaction.executeRaw(q(`INSERT INTO r VALUES ('two')`)));
      expect(failure.kind).toBe("TransactionAlreadyClosed");

      await transaction.commit();
    } finally {
      await adapter.dispose();
    }
  });

  test("a rollback discards everything the transaction wrote", async () => {
    const adapter = await open(ROWS);
    try {
      const transaction = await adapter.startTransaction();
      await transaction.executeRaw(q(`INSERT INTO r VALUES ('one')`));
      await transaction.rollback();

      const { rows } = await adapter.queryRaw(q(`SELECT id FROM r`));
      expect(rows).toEqual([]);

      await transaction.rollback();
    } finally {
      await adapter.dispose();
    }
  });

  test("a second transaction waits, because one connection holds one transaction", async () => {
    const adapter = await open(ROWS);
    try {
      const first = await adapter.startTransaction();
      const order: string[] = [];
      const pending = adapter.startTransaction().then((transaction) => {
        order.push("second began");
        return transaction;
      });

      // No wall clock: a macrotask boundary flushes every pending microtask, and
      // an implementation without the queue would have run — and failed — its
      // second BEGIN by then.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual([]);

      order.push("first committed");
      await first.commit();
      const second = await pending;
      expect(order).toEqual(["first committed", "second began"]);

      await second.executeRaw(q(`INSERT INTO r VALUES ('two')`));
      await second.commit();

      expect(await adapter.queryRaw(q(`SELECT id FROM r`))).toMatchObject({ rows: [["two"]] });
    } finally {
      await adapter.dispose();
    }
  });

  test("only SERIALIZABLE is accepted, because that is what one SQLite writer gives", async () => {
    const adapter = await open(ROWS);
    try {
      const failure = await failureOf(adapter.startTransaction("READ COMMITTED"));
      expect(failure).toMatchObject({ kind: "InvalidIsolationLevel", level: "READ COMMITTED" });

      const transaction = await adapter.startTransaction("SERIALIZABLE");
      await transaction.commit();
    } finally {
      await adapter.dispose();
    }
  });

  test("savepoints scope a rollback, which is what a nested $transaction needs", async () => {
    const adapter = await open(ROWS);
    try {
      const transaction = await adapter.startTransaction();
      // Optional on Prisma's `Transaction`, so a test calling them optionally
      // would pass by skipping them. `.call` keeps `this`.
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
    } finally {
      await adapter.dispose();
    }
  });
});

describe("open", () => {
  test("the pragmas are applied, and an override replaces just its own default", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "janela.sqlite");

      const adapter = await open(undefined, { path });
      try {
        expect(await pragma(adapter, "journal_mode")).toBe("wal");
        expect(await pragma(adapter, "synchronous")).toBe(1);
        expect(await pragma(adapter, "foreign_keys")).toBe(1);
        expect(await pragma(adapter, "busy_timeout")).toBe(2000);
      } finally {
        await adapter.dispose();
      }

      const overridden = await open(undefined, { path, pragmas: { synchronous: "FULL" } });
      try {
        expect(await pragma(overridden, "synchronous")).toBe(2);
        expect(await pragma(overridden, "journal_mode")).toBe("wal");
        expect(await pragma(overridden, "busy_timeout")).toBe(2000);
      } finally {
        await overridden.dispose();
      }
    });
  });

  test("foreign keys are enforced, because the cascade rules are the product rules", async () => {
    const adapter = await open(
      `CREATE TABLE p (id TEXT PRIMARY KEY);
       CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE);`,
    );
    try {
      const failure = await failureOf(
        adapter.executeRaw(q(`INSERT INTO c VALUES ('c1', 'missing')`)),
      );
      expect(failure.kind).toBe("ForeignKeyConstraintViolation");

      await adapter.executeScript(
        `INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');`,
      );
      await adapter.executeRaw(q(`DELETE FROM p WHERE id = 'p1'`));

      expect(await adapter.queryRaw(q(`SELECT count(*) FROM c`))).toMatchObject({ rows: [[0]] });
    } finally {
      await adapter.dispose();
    }
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
    const adapter = await open(
      `CREATE TABLE p (id TEXT PRIMARY KEY);
       CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT NOT NULL);`,
    );
    try {
      await adapter.executeRaw(q(`INSERT INTO p VALUES ('p1')`));

      expect(await failureOf(adapter.executeRaw(q(`INSERT INTO p VALUES ('p1')`)))).toMatchObject({
        kind: "UniqueConstraintViolation",
        constraint: { fields: ["id"] },
      });
      expect(
        await failureOf(adapter.executeRaw(q(`INSERT INTO c VALUES ('c1', NULL)`))),
      ).toMatchObject({ kind: "NullConstraintViolation", constraint: { fields: ["pid"] } });
    } finally {
      await adapter.dispose();
    }
  });

  test("a missing table and a missing column are named", async () => {
    const adapter = await open(`CREATE TABLE r (id TEXT PRIMARY KEY);`);
    try {
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
    } finally {
      await adapter.dispose();
    }
  });

  test("the original SQLite message and code survive for the log", async () => {
    const adapter = await open(`CREATE TABLE r (id TEXT PRIMARY KEY);`);
    try {
      const failure = await failureOf(adapter.executeRaw(q(`INSERT INTO r VALUES (1), (1)`)));

      expect(failure.originalMessage).toBe("UNIQUE constraint failed: r.id");
      expect(failure.originalCode).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    } finally {
      await adapter.dispose();
    }
  });
});

describe("dispose", () => {
  test("closes the connection, and stays closed", async () => {
    const adapter = await open(`CREATE TABLE r (id TEXT PRIMARY KEY);`);

    await adapter.dispose();

    const failure = await failureOf(adapter.queryRaw(q(`SELECT id FROM r`)));
    expect(failure.originalMessage).toContain("closed");

    await adapter.dispose();
  });
});
