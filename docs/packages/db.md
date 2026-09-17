# @janela/db

Layer 3, daemon side: the on-disk metadata store. It owns the schema, the
migrations, and the mapping between SQL rows and `@janela/core` values, and it
contains no business rules — what it means to delete a session lives in
`@janela/session`; this package only knows that deleting one cascades to its
terminals.

The only package permitted to import `@prisma/client` or `bun:sqlite`
(`scripts/layers.ts` gates both here). The corollary is stronger than the import
rule: **no Prisma type may escape this package.** `codec.ts` and
`prisma-repositories.ts` are the only files that name one, and neither is
exported from `index.ts` — a generated model type in a `@janela/session`
signature would make the schema part of the brain's API.

`janelad` opens the store, and nothing else ever does. WAL mode would tolerate
multi-process access, so one writer is a choice rather than a limitation: two
writers means two sources of truth, reconciliation logic, and a class of bug
where the app's view of a session disagrees with the process running it.

## Effect at the seams

Every `try`/`catch`/`finally` in this package was a resource lifetime or an
untrusted-value parse. The lifetimes are `Effect.acquireRelease` inside
`Effect.scoped`; the parses are `Schema`. Both are discharged at this package's
own boundary, because everything Prisma calls is `Promise`-shaped: the public API
is unchanged and nothing above `@janela/db` sees an `Effect`.

`bun:sqlite` is synchronous, so the adapter's programs are run with
`Effect.runSync` inside an `async` method rather than `Effect.runPromise` — the
failure still arrives as a rejection, and nothing pays for a fiber suspension per
query. `Effect.runSync`/`runPromise` re-raise the original error object, so
`instanceof MigrationFailed` and Prisma's structural `DriverAdapterError` check
still hold at the edge.

Two tables are `Map`s rather than the `Record`s this repo normally prefers
(`COLUMN_TYPES_BY_DECLARATION`, `FROM_SCALAR_STRING`). Their keys are arbitrary
runtime strings — a `sqlite3_column_decltype` name, a scalar-type tag off the
wire — and an indexable `Record<string, T>` annotation is the "open dictionary"
the linter rejects. A `Map` lookup is typed, exhaustively constructed once at
module load, and allocates nothing per lookup.

## index.ts

Exports `adapter.ts`, `errors.ts`, `database.ts` and `repositories.ts`, and
nothing else. `codec.ts`, `migrations.ts` and `prisma-repositories.ts` name
Prisma or SQL types; the daemon reaches them through `JanelaDatabase`.

## errors.ts

Three classes, all `UserFacingError` subclasses, because the `instanceof`
contract in `@janela/support` is load-bearing across the daemon/client decision.
None of them carries a `_tag`: nothing branches on one, and a tag nobody matches
is noise.

`MigrationFailed` is **fatal**: the daemon cannot start, and the only way a user
learns about it is a client that cannot connect. It must be logged clearly and
exit non-zero so launchd's `KeepAlive` does not spin.

The other two are the same defect seen from opposite sides of the store, and
keeping them apart is what makes a log readable:

| Class | Raised | Means |
| --- | --- | --- |
| `CorruptRecord` | on read | the file on disk says something the domain cannot represent — someone edited it, or an older Janela wrote a row a newer one cannot read |
| `InvalidRecord` | on write, before any I/O | *we* were about to write one. A bug in a caller above this package, caught before the row lands |

`InvalidRecord` exists so that a caller's bug never lands a row a later read
would have to refuse. `requireWritableSession` runs before the transaction opens.

**`reasons` name columns and rules, never stored values.** They reach a log, and
the log is not a place for a user's paths, branch names or argv. The one apparent
exception is the layout reasons, which are `layoutViolations`' own strings: those
carry ids, counts and fractions — shapes, not content.

## codec.ts

Rows in, `@janela/core` values out — and back. This is where the three lossy
mappings are paid for, and the rule set is what keeps a corrupt file from
becoming a plausible-looking lie.

- **A discriminator with payload columns is CORRUPT when it is inconsistent.**
  `backingKind`, `worktreeOwnership`, `worktreeRoot`, a terminal's `role`, an
  automation `event`, and every argv/environment JSON column. A half-populated
  worktree backing is *representable* in SQL and meaningless in the domain, so it
  is rejected rather than guessed. Guessing would put a session in front of a user
  whose "delete the worktree too" answer we invented.
- **A cosmetic or cached enumeration DEGRADES.** `accent` falls back to `none`; an
  unrecognised `forge` becomes absent; each with a warning. Refusing to load a
  project because a colour name is unknown is a worse outcome than a grey dot, and
  forgetting which forge a project uses costs a badge rather than the user's
  sessions.
- **`layout` is REPAIRED, never thrown.** See below.

Optional core fields are built with a mutable local and a conditional assignment,
never a conditional spread and never `{ key: undefined }`:
`exactOptionalPropertyTypes` makes present-and-undefined a different value from
absent, and the distinction is load-bearing on the way back out to the wire.

Absent `git` on a project is all three columns NULL, and nothing else. The
corollary is a contract for whoever registers a repository: always record
`defaultBranch`, or a project with a remote reads back as not a repository at all.

A worktree binding's `path` has no column of its own — it *is* the session's
`directory` — and `sessionViolations` refuses a value where the two disagree.

An argv array that round-trips into a string is the quoting bug class coming back
in through the database, so a stored `'"claude --dangerous"'` is refused rather
than read as one word. `Schema.Array(Schema.String)` under
`Schema.fromJsonString` is what refuses it; `Schema.Record(Schema.String,
Schema.String)` refuses an environment stored as an array, which a hand-rolled
`typeof` walk over `Object.entries` did not.

### The layout is repaired, not rejected

`docs/testing.md` § "Layout algebra" is the specification: a layout referencing a
terminal that no longer exists is **repaired on load**, and the session opens. A
session the user cannot open is worse than a session that lost a split. So the
persisted-JSON decode is deliberately split in two:

1. `StoredLayoutSchema` decides only what a layout *is*: a tabs array, a numeric
   `focusedTabIndex`, an optional string `title`, and panes that are either a
   terminal with an id or a split with an axis, a fraction and two children. It
   judges neither depth nor fraction range.
2. `@janela/core` decides what a layout *means*. `layoutViolations` reports, and
   `repairLayout` truncates past `MAXIMUM_PANE_DEPTH`, clamps fractions into
   `FRACTION_RANGE`, drops panes naming absent terminals, and re-seats focus.

That split is why the schema uses `Schema.Number` and not `Schema.Int` for
`focusedTabIndex`, and why the split pane carries an unchecked `fraction`. A
fractional tab index and an out-of-range fraction are **repairs** — `1.5` becomes
tab 0 — and a schema check there would turn a repair into a lost layout. Depth and
duplicate-terminal checks are refusals only on the *write* side, where
`layoutViolations` feeds `InvalidRecord`: the daemon never stores a tree it would
then have to truncate.

A layout that fails the decode is logged as `layout unreadable, rebuilt` and
replaced with one tab per terminal, so a lost layout loses arrangement and never
a terminal.

Two consequences of decoding with a schema rather than a `typeof` walk, both
deliberate:

- **A pane id must have the 8-4-4-4-12 shape** (`Schema.isGUID()`, which accepts
  exactly what `identifier()` accepts), because a `TerminalID` is that or it is
  nothing. The old shape check accepted any string and let `repairLayout` drop the
  pane — which for a single-tab layout dropped the *tab*, leaving
  `{ tabs: [], focusedTabIndex: 0 }` and every terminal unreachable. Rebuilding is
  strictly better, and there is a test for it.
- **Branding stops one level below what the algebra keeps.** `repairLayout`
  truncates at `MAXIMUM_PANE_DEPTH`, so `brandPane` walks faithfully to
  `MAXIMUM_PANE_DEPTH + 1` and collapses anything deeper to that subtree's
  leftmost terminal — which is exactly what `firstTerminalID` would have returned
  from the full tree. The result is identical for every layout, and the recursion
  is bounded rather than proportional to whatever is on disk. `Schema`'s own
  recursive decode is not bounded, so the decode is lifted with
  `Option.liftThrowable`: a tree deep enough to exhaust the stack is an unreadable
  layout, not a lost session.

## adapter.ts

The Prisma driver adapter over `bun:sqlite`.

### Why this is ours and not a dependency

Prisma 7 has no built-in SQLite driver: every database goes through a driver
adapter, and the two obvious candidates both fail here.

- `@prisma/adapter-better-sqlite3`, the first-party one, cannot be used at all.
  Bun refuses `better-sqlite3` outright and points at `bun:sqlite` instead
  (oven-sh/bun#4290). Measured, not assumed.
- `@prisma/adapter-libsql` works under `bun run`, but its native addon is not
  embedded by `bun build --compile`, so the compiled sidecar fails at runtime with
  a missing `@libsql/darwin-arm64`. Shipping the addon alongside the binary would
  work and would cost the single-file sidecar and a second artifact to sign.

`bun:sqlite` is built into the runtime, so it survives `--compile` with nothing to
ship. A third-party `bun:sqlite` adapter exists and works — it is the reference
for this file — but the daemon's only durable state is not a place for a v0.x
single-maintainer dependency. The interface is small and first-party
(`@prisma/driver-adapter-utils` supplies the types), so owning it is a bounded
cost; the escape hatch is to take the dependency after all.

### Pragmas

`DEFAULT_PRAGMAS` is applied on open, in order, before any override, and each one
is a decision: WAL so a read never blocks a write; `synchronous = NORMAL`, because
losing the last few milliseconds of a session list to a power cut is not worth an
fsync per commit; `foreign_keys = ON`, because the cascade rules *are* the product
rules; a 2 s busy timeout, so nothing blocks indefinitely on a lock that should
not exist given there is one writer. A key in `OpenOptions.pragmas` replaces the
default of the same name.

A pragma takes no bound parameters, so its value is interpolated — which makes
validating it the difference between a setting and a statement. Both the name and
the value must be bare, and the refusal is an `InvalidInputValue`.

The connection is opened with `safeIntegers`, so a 64-bit INTEGER never silently
loses precision on the way out.

### Column typing

SQLite is dynamically typed: a column's type comes from its *declared* type when
the statement has one, and from the *value* otherwise. Getting it wrong does not
throw — it hands Prisma a number where a string was expected, which surfaces much
later as a decode error on a field nobody touched.

The declared type wins wherever there is one: an INTEGER column holding the REAL
`1.5` is an `Int32` (and the row mapper truncates the value), and a TEXT column is
`Text` whatever a row happens to contain. `COLUMN_TYPES_BY_DECLARATION` is
SQLite's own type-name table plus what Prisma's migration engine writes —
`INTEGER UNSIGNED` in `_prisma_migrations`, and `DECIMAL` for `Decimal` fields.

`Statement.columnTypes` is deliberately not consulted: it re-steps the statement,
which throws for anything not read-only (`INSERT … RETURNING`, `PRAGMA`), and it
reports only the first row's storage class anyway. For a column with no declared
type, every row is scanned rather than just the first: a leading NULL says nothing
about the column. If every row is NULL, or there are no rows, the type is
unobservable and `Int32` is used — a NULL decodes to `null` under any of them.

**This is a representation dispatch, not a shape guess**, so it branches on
`Predicate.isString`/`isNumber`/`isBigInt`/`isBoolean`/`isUint8Array` rather than
on a parse. A value that is `number` and not `bigint` can only be a REAL, because
`safeIntegers` is on.

`columnNames.length !== declaredTypes.length` is refused as
`InconsistentColumnData`. bun collapsed same-named columns in `columnNames` while
`values()` kept every one of them, so the names stopped lining up with the values
and there is no way to tell which position lost its name; refusing beats handing
Prisma a row decoded against the wrong column. Aliasing duplicate columns is what
the refusal asks for, and the test asserts the invariant both bun versions owe us
rather than pinning either behaviour.

### Per-query cost

This adapter is on the daemon's database path — `docs/performance.md` § Launch
("Daemon: database open + first read") and § "Session creation" — so nothing here
allocates per row, per column or per bound argument. The row mapper, the argument
binder and the scalar-string converter use `Predicate` guards and a `Map` lookup
rather than `Match.value(...).pipe(...)`, whose closures would cost an allocation
per cell. `Match` appears only where the dispatch happens at most once per
undeclared column (`columnTypesFor`) or once per failure (`toDriverAdapterError`).

A `Date` argument is written as `…T…+00:00`, which is what
`@prisma/adapter-better-sqlite3` writes and what SQLite's date functions parse —
`Z` is not in SQLite's accepted set. A DATETIME column holding a number or bigint
comes back as an ISO string, which is Quaint's legacy encoding and what a
`DEFAULT (unixepoch())` writes. A bigint leaves as a number when it is a safe
integer and as a string otherwise: the runtime refuses a bigint outright ("Cannot
serialize value of type bigint as Int32") and accepts a string for both integer
widths.

`prepare` and not `query`: the latter caches every distinct SQL string for the
connection's lifetime with no bound (non-negotiable 9), and this store is
kilobytes, so recompiling is noise. The statement's lifetime is an
`Effect.acquireRelease` inside `Effect.scoped`, so it is finalized whether the
step succeeded, failed, or was interrupted.

### Transactions

One SQLite connection holds one transaction at a time: a second `BEGIN` fails with
"cannot start a transaction within a transaction". Prisma will happily start two
interactive transactions at once, so `TransactionLock` queues them. It is a
promise chain rather than a queue of waiters — nothing accumulates that is not
already an outstanding `$transaction`, and Prisma's own `maxWait` (2 s) bounds how
long one waits before it gives up and rolls back.

`BEGIN IMMEDIATE`, not `BEGIN`: the daemon is the only writer, so in steady state
the two are the same — but a deferred transaction that upgrades to a write while
something else holds the write lock (a developer's `sqlite3` shell) fails with
`SQLITE_BUSY` immediately, bypassing `busy_timeout`. Taking the write lock up
front is what makes "2 s busy timeout, and no retry loop" true rather than
aspirational. If the `BEGIN` fails, `Effect.tapError` releases the queue slot and
the original failure still propagates.

`usePhantomQuery` is `true`: the runtime calls `commit()`/`rollback()` on the
transaction object and expects them to issue the statement, rather than sending
`COMMIT` through `executeRaw` and treating these as bookkeeping. It keeps the SQL
and the lock release in one place. A failed `COMMIT` can leave the transaction
open, which would hold the write lock for the life of the daemon, so `commit`
rolls back on failure; `rollback` checks `inTransaction` first, because SQLite
rolls back by itself after some errors and a bare `ROLLBACK` then fails with
"cannot rollback - no transaction is active". The lock release is
`Effect.ensuring`, so it happens on every path. Savepoints exist because without
them a nested `$transaction` fails with "Nested transactions are not supported by
adapter"; Prisma generates the names (`prisma_sp_0`), so a name that is not a bare
identifier is a bug, not input.

Only `SERIALIZABLE` is accepted. One writer on one connection: SQLite has nothing
weaker to offer.

### Error mapping

Prisma recognises an adapter error structurally — `name === "DriverAdapterError"`
with an object `cause` — and maps `cause.kind` onto its own codes: a
`UniqueConstraintViolation` becomes P2002, a `ForeignKeyConstraintViolation`
P2003. Anything unmapped still reaches the user with its message intact, and the
original SQLite code and message are kept on every payload for the log Prisma
writes.

The code is read off `SQLiteError` — `bun:sqlite`'s own class, which carries
`errno` always and `code` only for extended codes — rather than probed for with
`in` and `typeof`. A closed connection throws a plain `RangeError`, which
`instanceof` sorts out on its own.

`MappedError` is already the tagged union Prisma branches on, so the code
dispatch is a `Match` over the SQLite code producing that payload directly; a
parallel `Data.TaggedError` here would have no consumer and no `Match`, `catchTag`
or `Predicate.isTagged` site to justify it. `SQLITE_BUSY` maps to `SocketTimeout`
because the busy timeout has already elapsed and there is no retry loop by design.
The rest are only distinguishable by their message — SQLite reports them all as
`SQLITE_ERROR` — so "no such table", "no such column" and "has no column named"
are matched on prefixes and everything else becomes a `sqlite` payload carrying
the extended code.

## database.ts

`JanelaDatabase` is the whole public API of this package. `defaultDatabasePath()`
is
`~/Library/Application Support/sh.janela.Janela/janela.sqlite` — not in a
container, because Janela is not sandboxed: it must spawn arbitrary user processes
in arbitrary directories. The socket lives elsewhere, at
`~/.janela/run/janelad.sock`, because `sockaddr_un.sun_path` is 104 bytes on macOS
and this directory does not fit in it. Only the socket moved.

SQLite creates the file but not its parents, and on a first launch there are none,
so `openDatabase` creates the directory. Doing it here rather than in the adapter
keeps the adapter about SQL.

`migrate()` opens a second, short-lived connection: Prisma does not hand out the
one it holds, and it connects lazily on first query, so at startup there is
nothing to borrow. One writer either way, since this runs before the daemon serves
anything. The connection's lifetime is an `Effect.acquireRelease` inside
`Effect.scoped`, so it is disposed whether the migrations succeeded or not, and
`MigrationFailed` still arrives at the caller as itself.

The default `Logger` discards, for the same reason `nullLogSink` does: a library
must not decide the format for a process that has not asked for one. The real sink
is injected, which is also what lets a test assert on a decode warning.

`temporaryDatabase()` is a real database on a temporary path, already migrated —
**not** in-memory. The migrations are the thing most likely to break a user's
session list, and a test that skips them is not testing that. Its `path` is the
tests' side door: corrupting a row means writing SQL the repositories would refuse,
and an injectable "write a bad row" seam would be a hole in the real API. The
temporary directory is built here rather than taken from `@janela/test-support`,
which is `tool`-side and importable only from a `*.test.ts`; `realpath` because on
macOS `tmpdir()` is `/var/folders/…` while everything else reports
`/private/var/folders/…`, and a path that does not compare equal makes every
assertion about it a lie.

## migrations.ts

`prisma migrate deploy` needs Node, the `prisma` package and the `prisma/`
directory. `janelad` ships as one compiled file and has none of the three, so the
migrations travel *inside* it: each one is a text import, and this module applies
the pending ones in order.

**Each directory under `prisma/migrations` has exactly one entry in `MIGRATIONS`,
by its exact name.** A new directory without an entry is a database that never gets
migrated in the shipped daemon while working perfectly under `bun run`; the
disk-parity test is what stops that reaching a user.

The bookkeeping table is Prisma's own `_prisma_migrations`, with Prisma's own
column set and Prisma's own checksum (sha256-hex of the raw SQL text). That is the
point: a database migrated by the daemon must be one `prisma migrate dev` can
carry forward on a developer's machine, and vice versa. `MIGRATIONS_TABLE_DDL` is
verbatim from Prisma's schema engine — do not tidy its alignment, because matching
Prisma's DDL is the whole value of the constant.

**Never edit a shipped migration.** That is enforced here rather than by review: a
user's database is already at this version, so rewriting it does nothing for them
and silently diverges everyone else. A checksum mismatch on a finished migration is
a `MigrationFailed`, and the tables are left exactly as the user had them. An
unfinished or rolled-back row describes an attempt, not a schema, and is treated as
pending — which is what `prisma migrate deploy` does too.

Migrations are strictly sequential, and that is the entire contract: migration N+1
is written against the schema N left behind, and they share one connection. Each
runs in its own transaction, so a failure leaves the database at the last complete
version rather than half-way through a schema change — SQLite makes DDL
transactional, which is the reason this is possible at all. The transaction is an
`Effect.acquireRelease` whose release rolls back only on a failing exit, which is
what replaced a rollback nested inside a failure handler; a rollback that itself
fails is logged as a class (`migration rollback failed`) and does not displace the
failure that got us there. The migration SQL is run through the *connection* and
not the transaction, because `executeScript` exists only on the connection and both
run on the one SQLite handle this adapter holds — so the script executes inside the
transaction opened above.

No pragmas are set here: the adapter applied them on connect.

Every migration needs two tests (`docs/testing.md` § Migrations): **forward from
the previous version** — open a database at version N−1, migrate, assert the data
survived, which is the test that stops us destroying a user's session list — and
the **cascade rules**, because they encode product rules. For v1 the previous
version is an empty database, and the cascade assertions live both in the shipped
SQL (`ON DELETE CASCADE` ×3, `ON DELETE SET NULL` ×2) and in behavioural tests over
a real store.

**v2 — `20260917120000_automation_scripts`.** `AutomationCommand` (an argv row per
command, with `isEnabled` and `position`) became `AutomationScript`, one row per
`(projectId, event)` holding a shell script. The conversion is done in SQL so it
runs inside the migration's transaction and needs nothing but SQLite: every argv
element is single-quoted (`'` → `'\''`), the elements join with a space, a disabled
row is prefixed `# `, and a project's rows for one event join with newlines in
their old `position` order — the only place SQLite's `group_concat` ordering is
relied on, and it is fed from an explicitly ordered temp table. The teardown
timeout is the first row's. Quoting *every* element rather than only the ones that
need it is the safe choice, and the script is the user's to tidy. The forward
test seeds four argv rows at v1 and asserts the exact script text, quoting and
order included.

## repositories.ts, prisma-repositories.ts

`repositories.ts` is the interface half and names only `@janela/core` types;
`prisma-repositories.ts` is the implementation and takes a `PrismaClient`. They are
separate files so that the type that must not escape cannot be reached from the one
`@janela/session` imports.

Three rules run through all of it:

- **A write validates first, then does I/O.** A caller's bug is reported as
  `InvalidRecord` before a row lands, because a row that lands is a row some later
  read has to refuse.
- **Children are reconciled, not merged.** `save` deletes the child rows the value
  no longer names and upserts the ones it does, in one transaction, so the stored
  set is exactly the value's set. The `id: { notIn: keep }` clause is omitted rather
  than emptied when a value names no children.
- **Cascades are the database's.** `remove` deletes one row and lets the foreign
  keys do the rest; emulating them here would be a second, divergent copy of the
  product rules the schema already states. `deleteMany` rather than `delete`, so an
  absent id is a no-op: callers reach here from a confirmation dialog, and a second
  click must not throw.

A project's directory clash surfaces as Prisma's P2002 and a missing profile as
P2003, and both propagate: they are caller bugs about identity, not decisions a
repository gets to make. A terminal naming a profile that does not exist is the
database's foreign key doing its job, and dressing it up as an `InvalidRecord`
would give us two copies of the rule.

Child upserts are sequential rather than `Promise.all`ed. One SQLite connection
holds one transaction, and the adapter's transaction lock serialises anything that
tries otherwise — so concurrency here would queue the same statements with more
moving parts, not fewer round trips.

A session's `position` is assigned once, on first insert, as max+1 within the
project or among standalone sessions. `save` never moves a session, because
reordering is a user action with its own entry point and this interface does not
have one yet. `all()` lists standalone sessions first, then each project's own
order; launch profiles come back in *name* order, not menu order, because which
profiles a menu shows and in what sequence is a presentation decision and this is a
store.

`seedBuiltIns` identifies a built-in by its **name**: ids are minted at seed time,
because a hardcoded id would collide with a user's own copy of a built-in. So an
edited built-in is recognised and left exactly as the user left it. Removing a
profile never deletes a terminal that referenced it — the column is
`ON DELETE SET NULL`, and a terminal with no profile falls back to the login
shell. Protecting a built-in from deletion is the job of the service that owns
that rule, not of a store.

## Tests

`docs/testing.md` § "We do not fake the database" applies in full: every test here
runs against a real SQLite file with the real migrations applied. `all()` is not
more forgiving than `find()` — one corrupt row fails the list, because a list
quietly missing a session is worse than an error.

Rows the repositories would refuse are written through the side door (`corrupt`),
which is the only way to test a decoder's refusals without putting a "write a bad
row" seam in the real API.
