# 0005. GRDB/SQLite rather than SwiftData

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Janela stores workspaces, repositories, session descriptors and launch profiles.
That is kilobytes of data with simple relationships, read once at launch and
written on user actions.

Two constraints shape the choice:

1. **Launch time is budgeted at 250 ms cold** ([`../performance.md`](../performance.md)).
   Opening the store is on the critical path.
2. **Migrations must be testable.** The schema will change, and a botched
   migration destroys a user's workspace list.

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

- Schema lives in `Migrations.swift` as an **append-only** `DatabaseMigrator`.
- WAL journaling, `synchronous = NORMAL`, `foreign_keys = ON`, 2 s busy timeout.
- `JanelaDatabase.inMemory()` gives tests a real database with no filesystem.

Rules, enforced by review:

1. **Never edit a shipped migration.** Add a new one.
2. Every migration gets a test that migrates a database at the previous version
   forward.
3. Cascade rules encode product rules: deleting a workspace deletes its sessions;
   it never deletes its repository. There is a test for exactly that.

What is **not** stored: terminal scrollback (unbounded and private — it lives in
the emulator's ring buffer and dies with the session), secrets (Keychain or the
user's own shell config), and anything derivable from git (we cache display values,
but git is the source of truth and we re-read rather than reconcile).

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
`JanelaWorkspace`.

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
- SwiftData gains a documented, testable migration story and stops pulling Core
  Data onto the launch path.
