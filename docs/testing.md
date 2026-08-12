# Testing

What we test, what we deliberately do not, and how to write a test that will still
be useful in a year.

---

## Tooling

**swift-testing** (`@Test`, `@Suite`, `#expect`, `#require`), not XCTest. Tests
live in `Packages/JanelaKit/Tests/<Module>Tests/`.

```bash
make test                                    # everything, seconds
cd Packages/JanelaKit && swift test --filter WorkspaceOrigin
```

XCTest remains for UI tests only, in `App/JanelaUITests/`, because
`XCUIApplication` has no swift-testing equivalent.

### `#expect` cannot swallow a `try`

This will not compile:

```swift
#expect(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session") == 0)
```

Hoist the throwing call, then assert on the value:

```swift
let count = try database.read { db in
    try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session")
}
#expect(count == 0)
```

### Tests run in parallel

`swift test` parallelises by default. Never write to a fixed path, never mutate
process-global state, never assume ordering. Use `TemporaryDirectory` and
`GitFixture` from `JanelaTestSupport`, both of which are unique per test.

---

## The testing pyramid, as it applies here

| Layer | What | How much |
| --- | --- | --- |
| **Domain rules** (`JanelaCore`) | Pure logic — origins, states, invariants | Exhaustive. Free and instant. |
| **Capabilities** (`Git`, `PTY`, `Persistence`) | Real behaviour against real resources | Thorough. This is where bugs live. |
| **Orchestration** (`JanelaWorkspace`) | Lifecycle with fakes for slow parts | Every state transition |
| **UI** (`JanelaUI`) | Rendering | Almost none — see below |
| **End-to-end** (`JanelaUITests`) | Full app | A handful of critical journeys |

---

## What we do and don't fake

This is the section worth reading twice.

### We do **not** fake git

`GitFixture` creates a real repository in a temporary directory and runs the real
`git`. Worktree behaviour is exactly the kind of thing a mock cannot verify: `git
worktree add` either works against a real repository or it does not, and a mock
would only assert that we call the function we think we call.

The fixture is hermetic — `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `commit.gpgsign=false`, a
minimal `PATH` — so it passes on a machine with signing and unusual global config.
Cost is a few hundred milliseconds per test. Worth it.

### We do **not** fake the database

`JanelaDatabase.inMemory()` is a real SQLite database with the real migrations
applied. A fake repository would test our fake.

### We do **not** fake PTYs for PTY tests

`JanelaPTY` tests spawn real processes — `/bin/echo`, `cat`, something that ignores
`SIGTERM` — and assert on real behaviour: that resizing delivers `SIGWINCH`, that
signalling reaches the process *group*, that closing reaps the child.

### We **do** fake slow or non-deterministic collaborators

When testing `JanelaWorkspace`, inject a fake `WorktreeServing` — the point of
those tests is the orchestration logic, not git. Same for clocks.

---

## What each layer should assert

### Domain rules

Encode **product decisions**, so that reversing one breaks a test. The existing
`WorkspaceOriginTests` is the model:

- a plain folder has no repository and no worktree
- both worktree flavours expose their binding uniformly
- only Janela-created worktrees may be deleted from disk

That last one is a safety rule stated as a test. If someone later makes adopted
worktrees deletable, they must consciously delete a test that says why not.

### Migrations

Every migration needs a test. Two kinds:

1. **Forward from the previous version.** Open a database at version N−1, migrate,
   assert the data survived. This is the test that stops us destroying a user's
   workspace list.
2. **Cascade rules**, because they encode product rules. `MigrationTests`
   already asserts that deleting a workspace deletes its sessions but never its
   repository.

Never edit a shipped migration. Add a new one and a new test.

### Concurrency and resource ownership

The bugs that will actually hurt are lifecycle bugs, so test them explicitly:

- closing a session terminates its child, including grandchildren
- a session that exits while unfocused still records `hasUnseenAttention`
- the read path applies back-pressure rather than growing without bound
- closing the fd in the cleanup handler, not before, so no `EV_VANISHED`

### UI

Test presentation *logic*, not rendering. If a view has logic worth testing, that
logic probably belongs in an `@Observable` store where it can be tested directly.
Snapshot tests are not currently used; they tend to fail on OS updates for reasons
unrelated to correctness.

---

## Performance tests

Budgets live in [`performance.md`](performance.md). They are not yet enforced
automatically; when a harness lands, start with:

1. Cold launch under 250 ms.
2. Sustained ≥ 100 MB/s terminal throughput with bounded memory.
3. 40 idle sessions under the memory budget.

Until then, record before/after numbers in the PR when changing anything on those
paths.

---

## Writing a good test here

- **Name the behaviour, not the method.** `@Test("Only Janela-created worktrees
  may be deleted from disk")` beats `testOwnsItsDirectory`.
- **One reason to fail.** If the name needs "and", split it.
- **Assert on outcomes, not calls.** `#expect(worktreeExists)` beats "verify
  `createWorktree` was called once".
- **A test for a bug reproduces the bug first.** Watch it fail, then fix it.
  Otherwise you have not proven the test covers the fix.
