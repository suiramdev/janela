import { UserFacingError } from "@janela/support";

export type RecordTable = "Project" | "Session" | "LaunchProfile";

const NOUN = {
  Project: "project",
  Session: "session",
  LaunchProfile: "launch profile",
} satisfies Readonly<Record<RecordTable, string>>;

export class MigrationFailed extends UserFacingError {
  override readonly summary = "Couldn't open Janela's database.";

  readonly migration: string;

  readonly underlying: unknown;

  constructor(migration: string, cause: unknown) {
    super(`migration ${migration} failed`, {
      recoverySuggestion: "If this keeps happening, please file an issue with the log.",
    });
    this.migration = migration;
    this.underlying = cause;
  }
}

export class CorruptRecord extends UserFacingError {
  override readonly summary: string;

  readonly table: RecordTable;

  readonly id: string;

  readonly reasons: readonly string[];

  constructor(table: RecordTable, id: string, reasons: readonly string[]) {
    super(`${table} ${id}: ${reasons.join("; ")}`);
    this.summary = `Couldn't read a saved ${NOUN[table]}.`;
    this.table = table;
    this.id = id;
    this.reasons = reasons;
  }
}

export class InvalidRecord extends UserFacingError {
  override readonly summary: string;

  readonly table: RecordTable;

  readonly id: string;

  readonly reasons: readonly string[];

  constructor(table: RecordTable, id: string, reasons: readonly string[]) {
    super(`${table} ${id}: ${reasons.join("; ")}`);
    this.summary = `Couldn't save the ${NOUN[table]}.`;
    this.table = table;
    this.id = id;
    this.reasons = reasons;
  }
}
