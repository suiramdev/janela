# 0019. Prisma over SQLite, through a `bun:sqlite` adapter we own

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** [0005](0005-persistence.md)

## Context

[0005](0005-persistence.md) chose GRDB over SQLite and gave four reasons: a fast and
predictable open on the launch path, plain SQL when we want it, migrations that are
code we can read and test, and a file inspectable with `sqlite3` when diagnosing a
user's problem. Every one of those survives the migration. GRDB does not.

So this ADR replaces the *library* and inherits the *rules*. Everything 0005 said
about what is stored, what is not, and how migrations behave is still in force and
is not restated here except where the new stack changes it.

The three constraints that decided this:

1. **The daemon ships as a single compiled binary.** `bun build --compile` embeds
   the runtime and the application; anything that cannot be embedded breaks the
   sidecar story ([0020](0020-bun-daemon-runtime.md)). This is the constraint that
   eliminated the obvious options.
2. **Migrations must be testable**, per 0005. The schema will change, and a botched
   migration destroys a user's session list.
3. **The database is daemon-private**, per 0015. One writer, one truth.

Prisma 7 is relevant here in a way earlier versions would not have been: it uses a
WASM query compiler plus a driver adapter, with no Rust query-engine binary to ship.
That removes the objection that would otherwise have ended this discussion.

Measured, on macOS 26 with Bun 1.3:

| Option | Result |
| --- | --- |
| `@prisma/adapter-better-sqlite3` | **Unusable.** Bun refuses `better-sqlite3` outright and says so, pointing at `bun:sqlite` (oven-sh/bun#4290). |
| `@prisma/adapter-libsql` | Works under `bun run`. **Fails compiled**: the native addon is not embedded, so the binary dies on a missing `@libsql/darwin-arm64`. |
| A driver adapter over `bun:sqlite` | **Works end to end.** Compiled to a single 69 MB file, run from an empty directory, real queries against a real database. |

`bun:sqlite` is built into the runtime, so there is nothing to embed and nothing to
ship alongside. That is the whole reason it wins.

## Decision

**Prisma as the SQL layer, over `bun:sqlite`, through a driver adapter that lives in
`@janela/db` rather than being a dependency.**

- **The schema is `prisma/schema.prisma`**, and it encodes the product rules 0005
  listed: deleting a project cascades to its sessions and their terminals; deleting a
  launch profile sets referencing columns null rather than deleting a descriptor; a
  session's `projectId` is nullable with `ON DELETE CASCADE`, because standalone
  sessions are first-class and an orphaned worktree-backed session would have a
  `backing` nothing could interpret. Verified by test, as 0005 required.
- **Migrations are `prisma migrate`**, producing ordered SQL under
  `prisma/migrations/`. 0005's rules are unchanged and remain unconditional: never
  edit a shipped migration, and every migration gets a test that opens a database at
  the previous version and migrates forward. **`prisma db push` is forbidden outside
  a scratch database** — it produces nothing to test, which would quietly retire
  0005's second rule.
- **The driver adapter is ours.** Prisma's adapter interface is small and its types
  are first-party (`@prisma/driver-adapter-utils`). A third-party `bun:sqlite`
  adapter exists and works — it is the reference implementation for ours — but it is
  a v0.x package with a single maintainer, and the daemon's only durable state is
  not where that belongs. This is the same standard 0005 applied when it accepted
  GRDB *because* it was mature and widely used.
- **`@janela/db` is the only package that may import `@prisma/client` or
  `bun:sqlite`**, enforced by [0022](0022-layering-enforcement.md). Repositories take
  and return `@janela/core` values; a generated Prisma model appearing in a
  `@janela/session` signature would make the schema part of the brain's API.
- **The database stays at
  `~/Library/Application Support/sh.janela.Janela/janela.sqlite`**, with the same
  pragmas 0005 chose: WAL, `synchronous = NORMAL`, `foreign_keys = ON`, 2 s busy
  timeout. Unchanged, including the reason the socket lives somewhere else
  ([0016](0016-daemon-protocol.md)).

### One operational fact that will bite someone

**Prisma's CLI runs on Node, not Bun, and refuses unsupported Node versions** — it
rejects Node 23 outright, by design. Bun is the runtime for everything we ship, but
`prisma generate` and `prisma migrate` shell out to Node regardless. So a supported
Node version is pinned in `.node-version` and in CI, and `bun run bootstrap` will
fail confusingly without one. This is written down because it is invisible from the
code and costs an hour to rediscover.

## Consequences

**Good.** A typed client generated from a schema, which is materially better than
hand-written row mapping for a schema this relational — and the cascade rules are
declared in one place rather than spread across `CREATE TABLE` statements.

**Good.** The single-binary property is preserved. The compiled daemon runs from a
directory containing nothing else, verified in CI on every push rather than assumed.

**Good.** Migrations are still ordered SQL files a human can read, and the database
is still inspectable with `sqlite3`. Both were 0005 requirements and both survive.

**Bad.** Prisma is a substantially larger dependency than GRDB was, and it brings a
code-generation step — which [0001](0001-project-generation.md) existed partly to
avoid, and which [0016](0016-daemon-protocol.md) rejected gRPC over. The difference
is that this generator's output is a typed client for a schema we own, not a build
system for the project; it runs in seconds, its output is gitignored, and nothing
else depends on it having run except the typechecker.

**Bad.** We now maintain a driver adapter. It is small, but it is code between our
data and our storage, and the subtle part is column typing: SQLite is dynamically
typed, so a column's type comes from the declared type when the statement has one
and from the value otherwise. Getting that wrong does not throw — it hands Prisma a
number where a string was expected and surfaces much later as a decode error on a
field nobody touched. That is the part to test hardest.

**Bad.** Two runtimes on the contributor's machine: Bun to run everything, Node to
run Prisma's CLI. Nothing we ship needs Node, which makes it exactly the kind of
requirement people forget.

**Bad.** The compiled binary is ~69 MB, most of which is the Bun runtime. Larger
than a Swift binary linking GRDB by an order of magnitude. It is a background daemon
downloaded once, so the cost is a bigger app bundle rather than anything the user
feels at runtime — but it is real and it is the price of the single-file property.

## Alternatives considered

**`bun:sqlite` directly, with hand-written SQL and no ORM.** Genuinely tempting, and
the closest thing to what GRDB was: no generator, no adapter, no Node, the smallest
possible dependency. Rejected because the mapping is where the bugs would live —
`Session.backing` is a discriminator plus four nullable columns, `SessionLayout` is
a recursive depth-bounded JSON blob, and `command`/`environment` are JSON that must
round-trip as an argv array rather than a string. Hand-writing that for five tables
plus their migrations is a meaningful amount of subtle code, and it is exactly the
code a schema-driven client writes correctly for free. This is the option to
reconsider if the adapter or the generator becomes a burden; the repositories are a
seam wide enough to swap what is behind them.

**Drizzle.** Lighter than Prisma, no generated client, works with `bun:sqlite`
directly and therefore needs no adapter and no Node. A close call, and the strongest
alternative. Rejected on migrations: Drizzle Kit's generated SQL is good but its
story for *testing* a migration forward from a previous version is weaker than
`prisma migrate`'s ordered directories, and 0005 made testable migrations a hard
requirement rather than a preference. Reconsider if the Node dependency proves
genuinely painful in practice.

**`@prisma/adapter-libsql`, shipping the native addon as a Tauri resource.** Would
work, and keeps a first-party adapter. Rejected: it trades the single-file sidecar
for a binary plus a `.node` addon that must be located, signed and notarized
alongside it, which is a real cost against
[0008](0008-sandboxing-and-distribution.md)'s signing story in exchange for not
writing a small adapter.

**Taking the third-party `bun:sqlite` adapter as a dependency.** Works today, and it
is well made. Rejected on the standard 0005 set for a dependency holding the
daemon's only durable state. If maintaining ours turns out to cost more than it
saves, taking it is the escape hatch, and it is a small change.

**Keep hand-rolled JSON on disk.** 0005 rejected this and its reasons are unchanged:
atomic partial updates and concurrent access get hand-rolled, and a corrupt write
loses everything rather than one row.

## Revisit when

- The adapter's column-type handling causes a bug in real data. That is the signal
  that owning it was the wrong call, and taking the third-party package — or
  dropping to `bun:sqlite` directly — is the response.
- The Node-for-Prisma requirement blocks CI or a contributor in a way pinning does
  not solve. Drizzle is the alternative that removes it.
- The store exceeds a few MB, which would mean we are storing something 0005 said we
  would not.
- Prisma ships a first-party `bun:sqlite` adapter, at which point ours should be
  deleted rather than kept for sentiment.
