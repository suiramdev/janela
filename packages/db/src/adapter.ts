/**
 * The Prisma driver adapter over `bun:sqlite`.
 *
 * ## Why this is ours and not a dependency
 *
 * Prisma 7 has no built-in SQLite driver: every database goes through a driver
 * adapter, and the two obvious candidates both fail here.
 *
 * - `@prisma/adapter-better-sqlite3`, the first-party one, cannot be used at all.
 *   Bun refuses `better-sqlite3` outright and says so, pointing at `bun:sqlite`
 *   instead (oven-sh/bun#4290). Measured, not assumed.
 * - `@prisma/adapter-libsql` works under `bun run`, but its native addon is not
 *   embedded by `bun build --compile`, so the compiled sidecar fails at runtime
 *   with a missing `@libsql/darwin-arm64`. Shipping the addon alongside the binary
 *   would work and would cost us the single-file sidecar and a second artifact to
 *   sign.
 *
 * `bun:sqlite` is built into the runtime, so it survives `--compile` with nothing
 * to ship. A third-party `bun:sqlite` adapter exists and works — it is the
 * reference for this file — but the daemon's only durable state is not a place to
 * put a v0.x single-maintainer dependency — the same standard ADR 0005 applied when
 * it accepted its SQLite library for being mature and widely used.
 *
 * The interface is small and first-party (`@prisma/driver-adapter-utils` supplies
 * the types), so owning it is a bounded cost. If it turns out not to be, the
 * escape hatch is to take the dependency after all — see
 * docs/decisions/0019-prisma-sql-layer.md § Revisit when.
 */

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";

import { ColumnTypeEnum, DriverAdapterError } from "@prisma/driver-adapter-utils";
import type {
  ArgScalarType,
  ArgType,
  ColumnType,
  IsolationLevel,
  MappedError,
  Provider,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlQueryable,
  SqlResultSet,
  Transaction,
  TransactionOptions,
} from "@prisma/driver-adapter-utils";

/** Reported to Prisma, and the name in an adapter error it did not recognise. */
const ADAPTER_NAME = "@janela/db";

/**
 * Applied on open, in this order, before any override. Each one is a decision;
 * `OpenOptions.pragmas` in database.ts is where they are explained.
 */
export const DEFAULT_PRAGMAS: Readonly<Record<string, string>> = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  foreign_keys: "ON",
  busy_timeout: "2000",
};

export interface JanelaSqliteAdapterOptions {
  /** A file path, or `":memory:"` for a throwaway store in tests. */
  readonly path: string;
  /** Layered over `DEFAULT_PRAGMAS`: a key here replaces the default of the same name. */
  readonly pragmas?: Readonly<Record<string, string>>;
}

/**
 * What `openDatabase` hands to `PrismaClient({ adapter })`.
 *
 * Prisma 7 takes the *factory*, not the connection: it calls `connect()` itself,
 * once, and `dispose()` on `$disconnect()`. The name is this package's so nothing
 * above @janela/db has to spell a Prisma type.
 */
export type JanelaSqliteAdapter = SqlDriverAdapterFactory;

export function janelaSqliteAdapter(options: JanelaSqliteAdapterOptions): JanelaSqliteAdapter {
  return {
    provider: "sqlite",
    adapterName: ADAPTER_NAME,

    // `async` so a failure to open — a missing directory, a file we cannot write —
    // arrives as a rejection rather than a synchronous throw from deep inside
    // Prisma's constructor.
    async connect(): Promise<SqlDriverAdapter> {
      try {
        return new BunSqliteConnection(openConnection(options));
      } catch (error) {
        throw toDriverAdapterError(error);
      }
    },
  };
}

function openConnection(options: JanelaSqliteAdapterOptions): Database {
  // `safeIntegers` so a 64-bit INTEGER never silently loses precision on the way
  // out; `mapRow` converts back to something Prisma can decode.
  const database = new Database(options.path, {
    create: true,
    readwrite: true,
    safeIntegers: true,
  });

  try {
    for (const [name, value] of Object.entries({ ...DEFAULT_PRAGMAS, ...options.pragmas })) {
      // A pragma takes no bound parameters, so the value is interpolated — which
      // makes validating it the difference between a setting and a statement.
      if (!/^[a-z_]+$/.test(name) || !/^[A-Za-z0-9_]+$/.test(value)) {
        throw new DriverAdapterError({
          kind: "InvalidInputValue",
          message: `not a bare pragma name and value: ${name}`,
        });
      }
      database.run(`PRAGMA ${name} = ${value}`);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}

// ---- Column typing.
//
// SQLite is dynamically typed: a column's type comes from its *declared* type
// when the statement has one, and from the *value* otherwise. Getting it wrong
// does not throw here — it hands Prisma a number where a string was expected,
// which surfaces much later as a decode error on a field nobody touched.

/**
 * `sqlite3_column_decltype` names, normalised. The list is SQLite's own type-name
 * table plus what Prisma's migration engine writes: `INTEGER UNSIGNED` in
 * `_prisma_migrations`, and `DECIMAL` for `Decimal` fields.
 */
const COLUMN_TYPES_BY_DECLARATION: Readonly<Record<string, ColumnType>> = {
  DECIMAL: ColumnTypeEnum.Numeric,
  FLOAT: ColumnTypeEnum.Float,
  DOUBLE: ColumnTypeEnum.Double,
  "DOUBLE PRECISION": ColumnTypeEnum.Double,
  NUMERIC: ColumnTypeEnum.Double,
  REAL: ColumnTypeEnum.Double,
  TINYINT: ColumnTypeEnum.Int32,
  SMALLINT: ColumnTypeEnum.Int32,
  MEDIUMINT: ColumnTypeEnum.Int32,
  INT: ColumnTypeEnum.Int32,
  INT2: ColumnTypeEnum.Int32,
  INTEGER: ColumnTypeEnum.Int32,
  SERIAL: ColumnTypeEnum.Int32,
  BIGINT: ColumnTypeEnum.Int64,
  INT8: ColumnTypeEnum.Int64,
  "UNSIGNED BIG INT": ColumnTypeEnum.Int64,
  DATE: ColumnTypeEnum.Date,
  DATETIME: ColumnTypeEnum.DateTime,
  TIMESTAMP: ColumnTypeEnum.DateTime,
  TIME: ColumnTypeEnum.Time,
  CHAR: ColumnTypeEnum.Text,
  CHARACTER: ColumnTypeEnum.Text,
  CLOB: ColumnTypeEnum.Text,
  "NATIVE CHARACTER": ColumnTypeEnum.Text,
  NCHAR: ColumnTypeEnum.Text,
  NVARCHAR: ColumnTypeEnum.Text,
  TEXT: ColumnTypeEnum.Text,
  VARCHAR: ColumnTypeEnum.Text,
  "VARYING CHARACTER": ColumnTypeEnum.Text,
  BLOB: ColumnTypeEnum.Bytes,
  BOOLEAN: ColumnTypeEnum.Boolean,
  JSON: ColumnTypeEnum.Json,
  JSONB: ColumnTypeEnum.Json,
};

const UNSIGNED_SUFFIX = " UNSIGNED";

/** `"varchar(20)"` → `"VARCHAR"`, `"INTEGER UNSIGNED"` → `"INTEGER"`. */
function normaliseDeclaration(declared: string): string {
  const collapsed = declared
    .toUpperCase()
    .replace(/\([^)]*\)/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.endsWith(UNSIGNED_SUFFIX)
    ? collapsed.slice(0, -UNSIGNED_SUFFIX.length)
    : collapsed;
}

/**
 * The declared type wins wherever there is one: an INTEGER column holding the
 * REAL `1.5` is an `Int32` (and `mapRow` truncates the value), and a TEXT column
 * is `Text` whatever a row happens to contain.
 *
 * `Statement.columnTypes` is deliberately not consulted: it re-steps the
 * statement, which throws for anything not read-only — `INSERT … RETURNING`,
 * `PRAGMA` — and it only reports the first row's storage class anyway.
 */
function columnTypesFor(
  declaredTypes: readonly (string | null)[],
  rows: readonly unknown[][],
): ColumnType[] {
  return declaredTypes.map((declared, index) => {
    const declaredType =
      declared === null ? undefined : COLUMN_TYPES_BY_DECLARATION[normaliseDeclaration(declared)];
    if (declaredType !== undefined) {
      return declaredType;
    }

    // An expression, or a column declared with no type at all. Scan every row,
    // not just the first: a leading NULL says nothing about the column.
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined) {
        continue;
      }
      switch (typeof value) {
        // Exact, because `safeIntegers` means a `number` can only be a REAL.
        case "bigint":
          return ColumnTypeEnum.Int64;
        case "number":
          return ColumnTypeEnum.Double;
        case "string":
          return ColumnTypeEnum.Text;
        case "boolean":
          return ColumnTypeEnum.Boolean;
        default:
          if (value instanceof Uint8Array) {
            return ColumnTypeEnum.Bytes;
          }
          throw new DriverAdapterError({
            kind: "UnsupportedNativeDataType",
            type: typeof value,
          });
      }
    }

    // Every row is NULL, or there are no rows: the type is unobservable, and a
    // NULL decodes to `null` under any of them.
    return ColumnTypeEnum.Int32;
  });
}

/** The value shapes `bun:sqlite` returns, in the shapes Prisma's decoder accepts. */
function mapRow(row: readonly unknown[], types: readonly ColumnType[]): unknown[] {
  return row.map((value, index) => {
    const type = types[index];
    if (value === null || value === undefined) {
      return null;
    }
    if (
      typeof value === "number" &&
      !Number.isInteger(value) &&
      (type === ColumnTypeEnum.Int32 || type === ColumnTypeEnum.Int64)
    ) {
      return Math.trunc(value);
    }
    if (
      type === ColumnTypeEnum.DateTime &&
      (typeof value === "number" || typeof value === "bigint")
    ) {
      // Quaint's legacy encoding, and what a `DEFAULT (unixepoch())` writes.
      return new Date(Number(value)).toISOString();
    }
    if (typeof value === "bigint") {
      // The runtime refuses a bigint outright ("Cannot serialize value of type
      // bigint as Int32"), and accepts a string for both integer widths.
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    return value;
  });
}

/** A Prisma argument in the shapes `bun:sqlite` binds. A `Date` is not one of them. */
function mapArg(arg: unknown, argType: ArgType | undefined): SQLQueryBindings {
  if (arg === null || arg === undefined) {
    return null;
  }
  if (typeof arg === "boolean") {
    return arg ? 1 : 0;
  }

  const value = typeof arg === "string" ? fromScalarString(arg, argType?.scalarType) : arg;
  if (value instanceof Date) {
    // What `@prisma/adapter-better-sqlite3` writes, and what SQLite's date
    // functions parse. `Z` is not in SQLite's accepted set.
    return value.toISOString().replace("Z", "+00:00");
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new DriverAdapterError({ kind: "UnsupportedNativeDataType", type: typeof value });
}

/**
 * The runtime sends most scalars as strings and names the type it meant. SQLite
 * has no decimal, so `decimal` becomes a float — the same precision loss the
 * first-party adapters document.
 */
function fromScalarString(
  arg: string,
  scalarType: ArgScalarType | undefined,
): string | number | bigint | Date | Uint8Array {
  switch (scalarType) {
    case "int":
      return Number.parseInt(arg, 10);
    case "float":
    case "decimal":
      return Number.parseFloat(arg);
    case "bigint":
      return BigInt(arg);
    case "datetime":
      return new Date(arg);
    case "bytes":
      return Buffer.from(arg, "base64");
    default:
      return arg;
  }
}

class BunSqliteQueryable implements SqlQueryable {
  readonly provider: Provider = "sqlite";
  readonly adapterName = ADAPTER_NAME;

  protected readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    try {
      // `prepare` and not `query`: the latter caches every distinct SQL string
      // for the connection's lifetime with no bound (non-negotiable 9), and this
      // store is kilobytes, so recompiling is noise.
      const statement = this.database.prepare<unknown, SQLQueryBindings[]>(query.sql);
      try {
        const rows: unknown[][] = statement.values(
          ...query.args.map((arg, index) => mapArg(arg, query.argTypes[index])),
        );
        // Both of these are only readable once the statement has been stepped.
        const { declaredTypes, columnNames } = statement;
        const columnTypes = columnTypesFor(declaredTypes, rows);

        if (columnNames.length !== declaredTypes.length) {
          // bun:sqlite collapses same-named columns in `columnNames` while
          // `values()` keeps every one of them, so the names no longer line up
          // with the values and there is no way to tell which position lost its
          // name. Refusing beats handing Prisma a row decoded against the wrong
          // column.
          throw new DriverAdapterError({
            kind: "InconsistentColumnData",
            cause: `the result has ${declaredTypes.length} columns but ${columnNames.length} distinct names; alias duplicate columns`,
          });
        }

        return {
          columnNames: [...columnNames],
          columnTypes,
          rows: rows.map((row) => mapRow(row, columnTypes)),
        };
      } finally {
        statement.finalize();
      }
    } catch (error) {
      throw toDriverAdapterError(error);
    }
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    try {
      const statement = this.database.prepare<unknown, SQLQueryBindings[]>(query.sql);
      try {
        return statement.run(...query.args.map((arg, index) => mapArg(arg, query.argTypes[index])))
          .changes;
      } finally {
        statement.finalize();
      }
    } catch (error) {
      throw toDriverAdapterError(error);
    }
  }
}

/** Overwritten synchronously by the executor in `acquire`, so it is never called. */
const UNSET_RELEASE = (): void => {};

/**
 * One SQLite connection holds one transaction at a time: a second `BEGIN` fails
 * with "cannot start a transaction within a transaction". Prisma will happily
 * start two interactive transactions at once, so they queue here.
 *
 * A promise chain rather than a queue of waiters: nothing accumulates that is
 * not already an outstanding `$transaction`, and Prisma's own `maxWait` (2 s)
 * bounds how long one waits before it gives up and rolls back.
 */
class TransactionLock {
  #tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release: () => void = UNSET_RELEASE;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = held;
    return previous.then(() => release);
  }
}

class BunSqliteConnection extends BunSqliteQueryable implements SqlDriverAdapter {
  readonly #lock = new TransactionLock();

  async executeScript(script: string): Promise<void> {
    try {
      this.database.run(script);
    } catch (error) {
      throw toDriverAdapterError(error);
    }
  }

  /**
   * The runtime never sends `BEGIN` itself, so this does.
   *
   * `BEGIN IMMEDIATE`, not `BEGIN`: the daemon is the only writer, so in steady
   * state the two are the same — but a deferred transaction that upgrades to a
   * write while something else holds the write lock (a developer's `sqlite3`
   * shell) fails with `SQLITE_BUSY` immediately, bypassing `busy_timeout`.
   * Taking the write lock up front is what makes "2 s busy timeout, and no retry
   * loop" true rather than aspirational.
   */
  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    if (isolationLevel !== undefined && isolationLevel !== "SERIALIZABLE") {
      // One writer, one connection: SQLite has nothing weaker to offer.
      throw new DriverAdapterError({ kind: "InvalidIsolationLevel", level: isolationLevel });
    }

    const release = await this.#lock.acquire();
    try {
      this.database.run("BEGIN IMMEDIATE");
    } catch (error) {
      release();
      throw toDriverAdapterError(error);
    }
    return new BunSqliteTransaction(this.database, release);
  }

  /** Idempotent, because `Database.close()` is. */
  async dispose(): Promise<void> {
    this.database.close();
  }
}

/** Prisma generates these (`prisma_sp_0`), so a name that is not bare is a bug, not input. */
const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class BunSqliteTransaction extends BunSqliteQueryable implements Transaction {
  /**
   * `true`: the runtime calls `commit()`/`rollback()` on this object and expects
   * them to issue the statement, rather than sending `COMMIT` through
   * `executeRaw` and treating these as bookkeeping. It keeps the SQL and the
   * lock release in one place.
   */
  readonly options: TransactionOptions = { usePhantomQuery: true };

  readonly #release: () => void;
  #open = true;

  constructor(database: Database, release: () => void) {
    super(database);
    this.#release = release;
  }

  override async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    if (!this.#open) {
      throw new DriverAdapterError({
        kind: "TransactionAlreadyClosed",
        cause: "queryRaw after the transaction finished",
      });
    }
    return super.queryRaw(query);
  }

  override async executeRaw(query: SqlQuery): Promise<number> {
    if (!this.#open) {
      throw new DriverAdapterError({
        kind: "TransactionAlreadyClosed",
        cause: "executeRaw after the transaction finished",
      });
    }
    return super.executeRaw(query);
  }

  async commit(): Promise<void> {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    try {
      this.database.run("COMMIT");
    } catch (error) {
      // A failed COMMIT can leave the transaction open; leaving it open would
      // hold the write lock for the life of the daemon.
      if (this.database.inTransaction) {
        this.database.run("ROLLBACK");
      }
      throw toDriverAdapterError(error);
    } finally {
      this.#release();
    }
  }

  async rollback(): Promise<void> {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    try {
      // SQLite rolls back by itself after some errors, and a bare `ROLLBACK`
      // then fails with "cannot rollback - no transaction is active".
      if (this.database.inTransaction) {
        this.database.run("ROLLBACK");
      }
    } catch (error) {
      throw toDriverAdapterError(error);
    } finally {
      this.#release();
    }
  }

  // Without these three, a nested `$transaction` fails with "Nested transactions
  // are not supported by adapter".
  async createSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `SAVEPOINT ${savepointName(name)}`, args: [], argTypes: [] });
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.executeRaw({ sql: `ROLLBACK TO ${savepointName(name)}`, args: [], argTypes: [] });
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.executeRaw({
      sql: `RELEASE SAVEPOINT ${savepointName(name)}`,
      args: [],
      argTypes: [],
    });
  }
}

function savepointName(name: string): string {
  if (!SAVEPOINT_NAME.test(name)) {
    throw new DriverAdapterError({
      kind: "InvalidInputValue",
      message: "a savepoint name must be a bare identifier",
    });
  }
  return name;
}

// ---- Errors.
//
// Prisma recognises an adapter error structurally — `name === "DriverAdapterError"`
// with an object `cause` — and maps `cause.kind` onto its own codes: a
// `UniqueConstraintViolation` becomes P2002, a `ForeignKeyConstraintViolation`
// P2003. Anything unmapped still reaches the user with its message intact.

function toDriverAdapterError(error: unknown): DriverAdapterError {
  if (error instanceof DriverAdapterError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return new DriverAdapterError({ kind: "GenericJs", id: 0, originalMessage: String(error) });
  }

  // `SQLiteError` carries `errno` always and `code` only for extended codes; a
  // closed connection throws a plain `RangeError`. Read both structurally.
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const extendedCode = "errno" in error && typeof error.errno === "number" ? error.errno : 0;
  const { message } = error;

  switch (code) {
    case "SQLITE_CONSTRAINT_UNIQUE":
    case "SQLITE_CONSTRAINT_PRIMARYKEY":
      return mapped(
        { kind: "UniqueConstraintViolation", ...violatedFields(message) },
        code,
        message,
      );
    case "SQLITE_CONSTRAINT_NOTNULL":
      return mapped({ kind: "NullConstraintViolation", ...violatedFields(message) }, code, message);
    case "SQLITE_CONSTRAINT_FOREIGNKEY":
    case "SQLITE_CONSTRAINT_TRIGGER":
      // SQLite never says which key, so there is nothing to name.
      return mapped(
        { kind: "ForeignKeyConstraintViolation", constraint: { foreignKey: {} } },
        code,
        message,
      );
    case "SQLITE_BUSY":
      // The busy timeout already elapsed. There is no retry loop by design.
      return mapped({ kind: "SocketTimeout" }, code, message);
    default:
      break;
  }

  // The rest are only distinguishable by their message: SQLite reports them all
  // as SQLITE_ERROR.
  const noSuchTable = "no such table: ";
  if (message.startsWith(noSuchTable)) {
    return mapped(
      { kind: "TableDoesNotExist", table: message.slice(noSuchTable.length) },
      code,
      message,
    );
  }
  const noSuchColumn = "no such column: ";
  if (message.startsWith(noSuchColumn)) {
    return mapped(
      { kind: "ColumnNotFound", column: message.slice(noSuchColumn.length) },
      code,
      message,
    );
  }
  const noColumnNamed = " has no column named ";
  const named = message.indexOf(noColumnNamed);
  if (named !== -1) {
    return mapped(
      { kind: "ColumnNotFound", column: message.slice(named + noColumnNamed.length) },
      code,
      message,
    );
  }

  return mapped({ kind: "sqlite", extendedCode, message }, code, message);
}

/** Keeps the original code and message on every payload, for the log Prisma writes. */
function mapped(
  payload: MappedError,
  code: string | undefined,
  message: string,
): DriverAdapterError {
  return new DriverAdapterError({
    ...payload,
    ...(code === undefined ? {} : { originalCode: code }),
    originalMessage: message,
  });
}

/** `"UNIQUE constraint failed: Project.directory"` → `["directory"]`. */
function violatedFields(message: string): { constraint?: { fields: string[] } } {
  const marker = "constraint failed: ";
  const at = message.indexOf(marker);
  if (at === -1) {
    return {};
  }
  return {
    constraint: {
      fields: message
        .slice(at + marker.length)
        .split(", ")
        .map((qualified) => qualified.slice(qualified.lastIndexOf(".") + 1)),
    },
  };
}
