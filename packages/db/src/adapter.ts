import { Database, SQLiteError } from "bun:sqlite";
import type { SQLQueryBindings, Statement } from "bun:sqlite";

import { ColumnTypeEnum, DriverAdapterError } from "@prisma/driver-adapter-utils";
import type {
  ArgScalarType,
  ArgType,
  ColumnType,
  Error as AdapterError,
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
import { Effect, Match, Predicate, Result } from "effect";
import type { Scope } from "effect";

export interface JanelaSqliteAdapterOptions {
  readonly path: string;
  readonly pragmas?: Readonly<Record<string, string>>;
}

export type JanelaSqliteAdapter = SqlDriverAdapterFactory;

interface FieldConstraint {
  readonly fields: string[];
}

interface ConstraintViolation<Kind extends string> {
  kind: Kind;
  constraint?: FieldConstraint;
}

type ScalarStringConverter = (arg: string) => string | number | bigint | Date | Uint8Array;

type PreparedStatement = Statement<unknown, SQLQueryBindings[]>;

const ADAPTER_NAME = "@janela/db";

export const DEFAULT_PRAGMAS = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  foreign_keys: "ON",
  busy_timeout: "2000",
} satisfies Readonly<Record<string, string>>;

const BARE_PRAGMA_NAME = /^[a-z_]+$/;

const BARE_PRAGMA_VALUE = /^[A-Za-z0-9_]+$/;

const COLUMN_TYPES_BY_DECLARATION = new Map<string, ColumnType>([
  ["DECIMAL", ColumnTypeEnum.Numeric],
  ["FLOAT", ColumnTypeEnum.Float],
  ["DOUBLE", ColumnTypeEnum.Double],
  ["DOUBLE PRECISION", ColumnTypeEnum.Double],
  ["NUMERIC", ColumnTypeEnum.Double],
  ["REAL", ColumnTypeEnum.Double],
  ["TINYINT", ColumnTypeEnum.Int32],
  ["SMALLINT", ColumnTypeEnum.Int32],
  ["MEDIUMINT", ColumnTypeEnum.Int32],
  ["INT", ColumnTypeEnum.Int32],
  ["INT2", ColumnTypeEnum.Int32],
  ["INTEGER", ColumnTypeEnum.Int32],
  ["SERIAL", ColumnTypeEnum.Int32],
  ["BIGINT", ColumnTypeEnum.Int64],
  ["INT8", ColumnTypeEnum.Int64],
  ["UNSIGNED BIG INT", ColumnTypeEnum.Int64],
  ["DATE", ColumnTypeEnum.Date],
  ["DATETIME", ColumnTypeEnum.DateTime],
  ["TIMESTAMP", ColumnTypeEnum.DateTime],
  ["TIME", ColumnTypeEnum.Time],
  ["CHAR", ColumnTypeEnum.Text],
  ["CHARACTER", ColumnTypeEnum.Text],
  ["CLOB", ColumnTypeEnum.Text],
  ["NATIVE CHARACTER", ColumnTypeEnum.Text],
  ["NCHAR", ColumnTypeEnum.Text],
  ["NVARCHAR", ColumnTypeEnum.Text],
  ["TEXT", ColumnTypeEnum.Text],
  ["VARCHAR", ColumnTypeEnum.Text],
  ["VARYING CHARACTER", ColumnTypeEnum.Text],
  ["BLOB", ColumnTypeEnum.Bytes],
  ["BOOLEAN", ColumnTypeEnum.Boolean],
  ["JSON", ColumnTypeEnum.Json],
  ["JSONB", ColumnTypeEnum.Json],
]);

const UNSIGNED_SUFFIX = " UNSIGNED";

const FROM_SCALAR_STRING = new Map<ArgScalarType, ScalarStringConverter>([
  ["int", (arg) => Number.parseInt(arg, 10)],
  ["float", (arg) => Number.parseFloat(arg)],
  ["decimal", (arg) => Number.parseFloat(arg)],
  ["bigint", (arg) => BigInt(arg)],
  ["datetime", (arg) => new Date(arg)],
  ["bytes", (arg) => Buffer.from(arg, "base64")],
]);

const SQLITE_UTC_OFFSET = "+00:00";

const UNSET_RELEASE = (): void => {};

const SAVEPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CONSTRAINT_MARKER = "constraint failed: ";

const NO_SUCH_TABLE = "no such table: ";

const NO_SUCH_COLUMN = "no such column: ";

const NO_COLUMN_NAMED = " has no column named ";

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

function columnTypesFor(
  declaredTypes: readonly (string | null)[],
  rows: readonly unknown[][],
): ColumnType[] {
  return declaredTypes.map((declared, index) => {
    const declaredType =
      declared === null
        ? undefined
        : COLUMN_TYPES_BY_DECLARATION.get(normaliseDeclaration(declared));

    if (declaredType !== undefined) return declaredType;

    for (const row of rows) {
      const value = row[index];

      if (value === null || value === undefined) continue;

      return Match.value(value).pipe(
        Match.when(Predicate.isBigInt, () => ColumnTypeEnum.Int64),
        Match.when(Predicate.isNumber, () => ColumnTypeEnum.Double),
        Match.when(Predicate.isString, () => ColumnTypeEnum.Text),
        Match.when(Predicate.isBoolean, () => ColumnTypeEnum.Boolean),
        Match.when(Predicate.isUint8Array, () => ColumnTypeEnum.Bytes),
        Match.orElse((other): ColumnType => {
          throw new DriverAdapterError({
            kind: "UnsupportedNativeDataType",
            type: Object.prototype.toString.call(other),
          });
        }),
      );
    }

    return ColumnTypeEnum.Int32;
  });
}

function mapRow(row: readonly unknown[], types: readonly ColumnType[]): unknown[] {
  return row.map((value, index) => {
    const type = types[index];

    if (value === null || value === undefined) return null;

    if (
      Predicate.isNumber(value) &&
      !Number.isInteger(value) &&
      (type === ColumnTypeEnum.Int32 || type === ColumnTypeEnum.Int64)
    ) {
      return Math.trunc(value);
    }

    if (
      type === ColumnTypeEnum.DateTime &&
      (Predicate.isNumber(value) || Predicate.isBigInt(value))
    ) {
      return new Date(Number(value)).toISOString();
    }

    if (Predicate.isBigInt(value)) {
      const asNumber = Number(value);

      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }

    return value;
  });
}

function fromScalarString(
  arg: string,
  argType: ArgType | undefined,
): string | number | bigint | Date | Uint8Array {
  const convert = argType === undefined ? undefined : FROM_SCALAR_STRING.get(argType.scalarType);

  return convert === undefined ? arg : convert(arg);
}

function boundArguments(query: SqlQuery): SQLQueryBindings[] {
  return query.args.map((arg, index) => {
    if (arg === null || arg === undefined) return null;

    if (Predicate.isBoolean(arg)) return arg ? 1 : 0;

    const value = Predicate.isString(arg) ? fromScalarString(arg, query.argTypes[index]) : arg;

    if (value instanceof Date) return value.toISOString().replace("Z", SQLITE_UTC_OFFSET);

    if (
      Predicate.isString(value) ||
      Predicate.isNumber(value) ||
      Predicate.isBigInt(value) ||
      value instanceof Uint8Array
    ) {
      return value;
    }

    throw new DriverAdapterError({
      kind: "UnsupportedNativeDataType",
      type: Object.prototype.toString.call(value),
    });
  });
}

function readResultSet(statement: PreparedStatement, query: SqlQuery): SqlResultSet {
  const rows: unknown[][] = statement.values(...boundArguments(query));
  const { declaredTypes, columnNames } = statement;
  const columnTypes = columnTypesFor(declaredTypes, rows);

  if (columnNames.length !== declaredTypes.length) {
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
}

function violatedFields(message: string): FieldConstraint | undefined {
  const at = message.indexOf(CONSTRAINT_MARKER);

  if (at === -1) return undefined;

  return {
    fields: message
      .slice(at + CONSTRAINT_MARKER.length)
      .split(", ")
      .map((qualified) => qualified.slice(qualified.lastIndexOf(".") + 1)),
  };
}

function constraintViolation<Kind extends "UniqueConstraintViolation" | "NullConstraintViolation">(
  kind: Kind,
  message: string,
): ConstraintViolation<Kind> {
  const violation: ConstraintViolation<Kind> = { kind };
  const constraint = violatedFields(message);

  if (constraint !== undefined) violation.constraint = constraint;

  return violation;
}

function mapped(
  payload: MappedError,
  code: string | undefined,
  message: string,
): DriverAdapterError {
  const cause: AdapterError = { ...payload, originalMessage: message };

  if (code !== undefined) cause.originalCode = code;

  return new DriverAdapterError(cause);
}

function fromMessage(message: string, extendedCode: number): MappedError {
  if (message.startsWith(NO_SUCH_TABLE)) {
    return { kind: "TableDoesNotExist", table: message.slice(NO_SUCH_TABLE.length) };
  }

  if (message.startsWith(NO_SUCH_COLUMN)) {
    return { kind: "ColumnNotFound", column: message.slice(NO_SUCH_COLUMN.length) };
  }

  const named = message.indexOf(NO_COLUMN_NAMED);

  if (named !== -1) {
    return { kind: "ColumnNotFound", column: message.slice(named + NO_COLUMN_NAMED.length) };
  }

  return { kind: "sqlite", extendedCode, message };
}

function toDriverAdapterError(cause: unknown): DriverAdapterError {
  if (cause instanceof DriverAdapterError) return cause;

  if (!(cause instanceof Error)) {
    return new DriverAdapterError({ kind: "GenericJs", id: 0, originalMessage: String(cause) });
  }

  const sqlite = cause instanceof SQLiteError ? cause : undefined;
  const { message } = cause;

  return Match.value(sqlite?.code).pipe(
    Match.whenOr("SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY", (code) =>
      mapped(constraintViolation("UniqueConstraintViolation", message), code, message),
    ),
    Match.when("SQLITE_CONSTRAINT_NOTNULL", (code) =>
      mapped(constraintViolation("NullConstraintViolation", message), code, message),
    ),
    Match.whenOr("SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_TRIGGER", (code) =>
      mapped(
        { kind: "ForeignKeyConstraintViolation", constraint: { foreignKey: {} } },
        code,
        message,
      ),
    ),
    Match.when("SQLITE_BUSY", (code) => mapped({ kind: "SocketTimeout" }, code, message)),
    Match.orElse((code) => mapped(fromMessage(message, sqlite?.errno ?? 0), code, message)),
  );
}

function attemptSqlite<A>(thunk: () => A): Result.Result<A, DriverAdapterError> {
  return Result.try({ try: thunk, catch: toDriverAdapterError });
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

function applyPragmas(
  database: Database,
  pragmas: Readonly<Record<string, string>> | undefined,
): void {
  for (const [name, value] of Object.entries({ ...DEFAULT_PRAGMAS, ...pragmas })) {
    if (!BARE_PRAGMA_NAME.test(name) || !BARE_PRAGMA_VALUE.test(value)) {
      throw new DriverAdapterError({
        kind: "InvalidInputValue",
        message: `not a bare pragma name and value: ${name}`,
      });
    }

    database.run(`PRAGMA ${name} = ${value}`);
  }
}

function openConnection(options: JanelaSqliteAdapterOptions): Database {
  const database = new Database(options.path, {
    create: true,
    readwrite: true,
    safeIntegers: true,
  });

  const applied = Result.try((): Database => {
    applyPragmas(database, options.pragmas);

    return database;
  });

  if (Result.isFailure(applied)) {
    database.close();

    throw applied.failure;
  }

  return applied.success;
}

function preparedStatement(
  database: Database,
  sql: string,
): Effect.Effect<PreparedStatement, DriverAdapterError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => database.prepare<unknown, SQLQueryBindings[]>(sql),
      catch: toDriverAdapterError,
    }),
    (open) =>
      Effect.sync(() => {
        open.finalize();
      }),
  );
}

export function janelaSqliteAdapter(options: JanelaSqliteAdapterOptions): JanelaSqliteAdapter {
  return {
    provider: "sqlite",
    adapterName: ADAPTER_NAME,

    async connect(): Promise<SqlDriverAdapter> {
      const connected = attemptSqlite(() => new BunSqliteConnection(openConnection(options)));

      if (Result.isFailure(connected)) throw connected.failure;

      return connected.success;
    },
  };
}

class BunSqliteQueryable implements SqlQueryable {
  readonly provider: Provider = "sqlite";

  readonly adapterName = ADAPTER_NAME;

  protected readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const { database } = this;

    return Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const statement = yield* preparedStatement(database, query.sql);

          return yield* Effect.try({
            try: () => readResultSet(statement, query),
            catch: toDriverAdapterError,
          });
        }),
      ),
    );
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    const { database } = this;

    return Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const statement = yield* preparedStatement(database, query.sql);

          return yield* Effect.try({
            try: () => statement.run(...boundArguments(query)).changes,
            catch: toDriverAdapterError,
          });
        }),
      ),
    );
  }
}

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

class BunSqliteTransaction extends BunSqliteQueryable implements Transaction {
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
    if (!this.#open) return;

    this.#open = false;

    const { database } = this;
    const release = this.#release;

    return Effect.runSync(
      Effect.try({
        try: () => {
          database.run("COMMIT");
        },
        catch: toDriverAdapterError,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (database.inTransaction) database.run("ROLLBACK");
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            release();
          }),
        ),
      ),
    );
  }

  async rollback(): Promise<void> {
    if (!this.#open) return;

    this.#open = false;

    const { database } = this;
    const release = this.#release;

    return Effect.runSync(
      Effect.try({
        try: () => {
          if (database.inTransaction) database.run("ROLLBACK");
        },
        catch: toDriverAdapterError,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            release();
          }),
        ),
      ),
    );
  }

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

class BunSqliteConnection extends BunSqliteQueryable implements SqlDriverAdapter {
  readonly #lock = new TransactionLock();

  async executeScript(script: string): Promise<void> {
    const { database } = this;

    const executed = attemptSqlite(() => {
      database.run(script);
    });

    if (Result.isFailure(executed)) throw executed.failure;
  }

  async startTransaction(isolationLevel: IsolationLevel | undefined): Promise<Transaction> {
    if (isolationLevel !== undefined && isolationLevel !== "SERIALIZABLE") {
      throw new DriverAdapterError({ kind: "InvalidIsolationLevel", level: isolationLevel });
    }

    const { database } = this;
    const release = await this.#lock.acquire();

    const started = attemptSqlite(() => {
      database.run("BEGIN IMMEDIATE");

      return new BunSqliteTransaction(database, release);
    });

    if (Result.isFailure(started)) {
      release();

      throw started.failure;
    }

    return started.success;
  }

  async dispose(): Promise<void> {
    this.database.close();
  }
}
