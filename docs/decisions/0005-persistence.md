# 0005. GRDB/SQLite rather than SwiftData

- **Status:** Accepted
- **Date:** 2026-08-12
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — the daemon is
  now the exclusive owner of the database. GRDB over SQLite is unchanged.

## Context

Janela stores projects, sessions, terminal descriptors, session layouts, automation
commands and launch profiles. That is kilobytes of data with simple relationships,
read once at launch and written on user actions.

Two constraints shape the choice:

1. **Launch time is budgeted at 250 ms cold** ([`../performance.md`](../performance.md)).
   Opening the store is on the critical path.
2. **Migrations must be testable.** The schema will change, and a botched
   migration destroys a user's session list.

SwiftData is the default Apple answer and integrates with SwiftUI via
`@Query`. But it is Core Data underneath — Apple's own coexistence documentation
describes them sharing a store format — which means adopting it loads the Core Data
framework on the launch path, against Apple's own guidance to reduce dynamic
library dependencies when optimising launch
([`../research/apple-platform-2.md`](../research/apple-platform-2.md) § 9).

Its migration story is also declarative and comparatively opaque, and its
concurrency model (`ModelActor`) constrains how we read from background work.

## Decision

**GRDB** over SQLite. The store is `JanelaDatabase`, a `Sendable` class wrapping a
`DatabasePool`, at
`~/Library/Application Support/sh.janela.Janela/janela.sqlite`.

**`janelad` opens it, and nothing else ever does.** Since
[0015](0015-daemon-owned-sessions.md) the database is daemon-private: clients read
state over the protocol and never touch the file. SQLite's WAL mode would tolerate
multi-process access, so this is a choice rather than a limitation, and it is worth
the restraint — two writers means two sources of truth, reconciliation logic, and a
class of bug where the app's view of a session disagrees with the process actually
running. One writer, one truth.

The corollary is a rule for reviewers: **a client module that imports
`JanelaPersistence` is a layering bug**, not an optimisation. `JanelaUI` and
`JanelaApp` do not link it at all.

- Schema lives in `Migrations.swift` as an **append-only** `DatabaseMigrator`.
- WAL journaling, `synchronous = NORMAL`, `foreign_keys = ON`, 2 s busy timeout.
- `JanelaDatabase.inMemory()` gives tests a real database with no filesystem.

Rules, enforced by review:

1. **Never edit a shipped migration.** Add a new one.
2. Every migration gets a test that migrates a database at the previous version
   forward.
3. Cascade rules encode product rules: deleting a project deletes its sessions;
   deleting a session deletes its terminals, its layout and its automation
   terminals; deleting a launch profile never deletes a descriptor that referenced
   it. There are tests for exactly those.
4. A session's `projectID` is nullable, because standalone sessions are
   first-class ([0009](0009-projects-sessions-terminals.md)). It is a foreign key
   with `ON DELETE CASCADE`, not `SET NULL` — orphaning a worktree-backed session
   from its project would leave a row whose `backing` cannot be interpreted.

What is **not** stored: terminal scrollback (unbounded and private — it lives in
the emulator's ring buffer and dies with the terminal), secrets (Keychain, or the
user's own tooling — forge credentials belong to `gh`, never to us, per
[0012](0012-forge-integration.md)), notification bodies
([0011](0011-notifications.md)), and anything derivable from git or a forge (we
cache display values with a timestamp, but git is the source of truth and we
re-read rather than reconcile).

One stored value deserves its bound in writing: `SessionLayout` is a recursive
tree, persisted as JSON, and is validated on both encode and decode to a maximum
depth of 6 ([0010](0010-terminal-layout.md)). An unbounded recursive `Codable`
read from disk is a decoding hazard, not a schema detail.

## Consequences

**Good.** Fast, predictable open. Plain SQL when we want it. Migrations are code
we can read and test. The file is inspectable with `sqlite3`, which matters when
diagnosing a user's problem. No Core Data on the launch path.

**Good.** GRDB works cleanly with Swift 6 concurrency and does not impose an
actor model on our domain types.

**Bad.** A third-party dependency for something Apple ships an answer to. GRDB is
mature, widely used and MIT licensed, so this is a small risk, but it is real.

**Bad.** No `@Query`. Views observe our `@Observable` stores instead, which is
more code — and also the layering we wanted anyway, since it keeps SwiftUI out of
`JanelaSession`.

## Alternatives considered

**SwiftData.** Least code and the most idiomatic with SwiftUI. Rejected on launch
cost, migration opacity, and the concurrency constraints its model actors impose.

**Core Data directly.** All of SwiftData's weight with none of its ergonomics.

**JSON file.** Genuinely tempting at this data size, and it is what cmux does
(`JSONConfigStore` behind a repository actor —
[`../research/prior-art-2.md`](../research/prior-art-2.md) § 1.4). Rejected because
atomic partial updates and concurrent access get hand-rolled, and because a
corrupt write loses everything rather than one row. We keep the repository-actor
*shape* of that design regardless.

## Revisit when

- The store exceeds a few MB, which would mean we are storing something we said we
  would not.
- Pre-release note: the `v1-initial` migration was rewritten once, in place, when
  the domain model changed ([0009](0009-projects-sessions-terminals.md)). That was
  legitimate only because nothing had shipped and no user database existed. The
  never-edit-a-shipped-migration rule applies from the first tagged release
  onward, without exception.
- Migration now runs inside the daemon at startup, which means a failed migration
  is a daemon that will not start rather than an app that will not launch. The
  failure has to surface through a client that cannot connect — see
  [0017](0017-daemon-lifecycle.md) § Registration for the degraded-mode story this
  shares.
- A second writer is ever genuinely needed. It is not needed for the CLI or a remote
  client: both are protocol clients.
- SwiftData gains a documented, testable migration story and stops pulling Core
  Data onto the launch path.
