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

// TODO: Implement the driver adapter over `bun:sqlite`.
//
// Prisma's `SqlDriverAdapter` needs four things, and only the third is subtle:
//
//   1. `executeRaw(query)` → affected row count.
//   2. `queryRaw(query)`   → `{ columnNames, columnTypes, rows }`.
//   3. Column types. SQLite is dynamically typed, so a column's type comes from
//      the *declared* type when the statement has one and from the *value*
//      otherwise. Getting this wrong does not throw: it silently hands Prisma a
//      number where it expected a string, which surfaces much later as a decode
//      error on a field nobody touched. This is the part worth testing hardest.
//   4. `transactionContext()` → BEGIN / COMMIT / ROLLBACK, with the one writer
//      assumption stated in `database.ts` meaning no retry loop is needed.
//
// Plus `dispose()`, and the pragmas from `OpenOptions` applied on open.

/** Prisma's adapter shape, as this package implements it. */
export type JanelaSqliteAdapter = unknown;

// TODO: Replace `unknown` with the imported `SqlDriverAdapter` type once the
// implementation lands. It is left deliberately opaque here so that no package
// above @janela/db can accidentally start naming a Prisma type in its own
// signatures — a generated client type in a service signature is a leaked schema.
