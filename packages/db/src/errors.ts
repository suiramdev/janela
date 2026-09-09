/**
 * What this package throws, and the line between the three.
 *
 * `MigrationFailed` is fatal: the daemon cannot start, and the only way a user
 * learns about it is a client that cannot connect.
 *
 * The other two are the same defect seen from opposite sides of the store, and
 * keeping them apart is what makes a log readable: `CorruptRecord` means the file
 * on disk says something the domain cannot represent — someone edited it, or an
 * older Janela wrote a row a newer one cannot read. `InvalidRecord` means *we*
 * were about to write one, and is a bug in a caller above this package, caught
 * before any I/O so the row never lands.
 *
 * `reasons` name columns and rules, never stored values. They reach a log, and
 * the log is not a place for a user's paths, branch names or argv.
 */

import { UserFacingError } from "@janela/support";

export class MigrationFailed extends UserFacingError {
  override readonly summary = "Couldn't open Janela's database.";

  readonly migration: string;
  readonly underlying: unknown;

  constructor(migration: string, underlying: unknown) {
    super(`migration ${migration} failed`, {
      recoverySuggestion: "If this keeps happening, please file an issue with the log.",
    });
    this.migration = migration;
    this.underlying = underlying;
  }
}

/** The tables whose rows map to a `@janela/core` value, so can disagree with one. */
export type RecordTable = "Project" | "Session" | "LaunchProfile";

const NOUN: Readonly<Record<RecordTable, string>> = {
  Project: "project",
  Session: "session",
  LaunchProfile: "launch profile",
};

/** Thrown on read: a stored row cannot become a domain value. */
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

/** Thrown on write, before any I/O: a domain value violates its own invariants. */
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
