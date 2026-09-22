# Testing

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> It describes the Swift stack — `make` targets, SwiftPM modules, SwiftTerm, GRDB,
> Xcode. The architecture, the domain model and the product thesis it serves are
> unchanged; the stack it names is gone.
>
> Current: [`AGENTS.md`](../AGENTS.md) for commands and layering,
> [`architecture.md`](architecture.md) for the system,
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md) for where every module, type and seam went.
> Rewriting this file is a tracked follow-up.


What we test, what we deliberately do not, and how to write a test that will still
be useful in a year.

---

## Tooling

**`bun test`** (`bun:test` — `describe`, `test`, `expect`), not XCTest and not
swift-testing. A test lives beside its subject as `<subject>.test.ts`, inside the
package that owns it.

```bash
bun test                                     # everything, seconds
bun test packages/daemon                     # one package
bun test packages/daemon/src/listener.test.ts
```

`bun run check` — `lint` + `typecheck` + `test` — is exactly what CI runs. There is
no separate UI-test target: the Tauri shell is exercised by hand with
`bun run desktop` ([`AGENTS.md`](../AGENTS.md) § Commands).

### Tests share one process

`bun test` runs every file in a single process, one after another, so leftovers
outlive the file that made them: never write to a fixed path, never mutate
process-global state, never assume ordering. Use `temporaryDirectory(label)` and
`gitFixture(label)` from `@janela/test-support` — each call makes its own directory
under `TMPDIR`, and both are `AsyncDisposable`, so `await using` removes it however
the test ends.

---

## The testing pyramid, as it applies here

| Layer | What | How much |
| --- | --- | --- |
| **Domain rules** (`JanelaCore`) | Pure logic — backings, states, layout algebra, invariants | Exhaustive. Free and instant. |
| **Protocol** (`JanelaProtocol`) | Framing, encoding, version negotiation | Exhaustive. Pure, and a wire format is worth pinning down. |
| **Capabilities** (`Git`, `PTY`, `Persistence`, `Forge`) | Real behaviour against real resources | Thorough. This is where bugs live. |
| **Orchestration** (`JanelaSession`) | Lifecycle and automation, with fakes for slow parts | Every state transition |
| **Daemon** (`JanelaDaemon`) | Real socket, real connections, real handshakes | Thorough — see below |
| **Client** (`JanelaClient`) | Mirror updates, reconnect, attention policy | Every state transition |
| **UI** (`JanelaUI`) | Rendering | Almost none — see below |
| **End-to-end** (`JanelaUITests`) | Full app | A handful of critical journeys |

The daemon row is new, and it pays better than it looks. Because the daemon's whole
interface is a socket, the entire session lifecycle is testable **headlessly, with
no window server**: start a daemon on a temporary socket path, connect a test
client, drive it with real messages, assert on what comes back. That is a far better
test surface than an `@Observable` store was — an argument *for* the architecture
rather than a consolation for it.

---

## What we do and don't fake

This is the section worth reading twice.

### We do **not** fake git

`gitFixture(label)` creates a real repository in a temporary directory and runs the
real `git`. Worktree behaviour is exactly the kind of thing a mock cannot verify:
`git worktree add` either works against a real repository or it does not, and a
mock would only assert that we call the function we think we call.

The same applies to **`.worktreeinclude`**, and more so. Its correctness *is*
git's pattern matching, so a test that fakes the matcher tests nothing. Write a
real `.gitignore`, a real `.worktreeinclude`, real ignored files, create a real
worktree, and assert on what landed in it — including what did **not**: an
ignored-but-unlisted directory, an untracked-but-unlisted file, and `.git`
itself.

The fixture is hermetic — `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `commit.gpgsign=false`, a
minimal `PATH` — so it passes on a machine with signing and unusual global config.
Cost is a few hundred milliseconds per test. Worth it.

### We do **not** fake the database

`openDatabase({ path })` against a file in a `temporaryDirectory()` — or
`":memory:"` where nothing needs to survive a reopen — is a real SQLite database
with the real migrations applied. A fake repository would test our fake.

### We do **not** fake PTYs for PTY tests

`JanelaPTY` tests spawn real processes — `/bin/echo`, `cat`, something that ignores
`SIGTERM` — and assert on real behaviour: that resizing delivers `SIGWINCH`, that
signalling reaches the process *group*, that closing reaps the child.

### We do **not** fake the socket

`@janela/daemon` tests bind a real Unix socket under a `temporaryDirectory()` and
connect real clients over it. A fake transport would test our fake, and every
interesting bug here is a real-socket bug: partial reads, a frame split across two
reads, a peer that vanishes mid-frame, a length prefix that lies.

**Mind the path limit, by hand.** `sun_path` is 104 bytes —
`MAXIMUM_SOCKET_PATH_LENGTH` in `packages/daemon/src/endpoint.ts`, which is pinned
to 104 by `endpoint.test.ts` and enforced in production by `defaultSocketPath()`,
the only place that throws `SocketPathTooLong`. There is **no socket-path helper**:
`@janela/test-support` exports `temporaryDirectory(label)` (with `path` and `join`)
and `gitFixture(label)`, and nothing else. So a socket test passes a short `label`,
builds the path with `join()` — `"d.sock"`, not the test's name — and asserts
`Buffer.byteLength(path)` against the constant *before* binding, which is what
`listener.test.ts` does in both of its fixtures. Assert rather than truncate: an
over-long path is not an error, it addresses a *different* socket.

The two cross-process files cannot use `TMPDIR` at all. On macOS the per-user
temporary directory is a `/var/folders/…/T/` path that spends roughly 50 of the 104
bytes before any label, and these tests spawn the daemon with a whole isolated
`HOME` (and `TMPDIR` pointed at it) and let it compute
`~/.janela/run/janelad.sock` itself — so `apps/daemon/src/survival.test.ts` and
`main.test.ts` call `mkdtemp("/tmp/jd-")` and `mkdtemp("/tmp/jd-main-")` directly,
as `scripts/dev.test.ts` does with `/tmp/janela-dev-`. Anywhere else, prefer the
fixture.

### We do **not** fake the emulator when testing the repaint encoder

The encoder's correctness claim is *"a client that applies these bytes ends up with
the grid the daemon has"* — directly testable with two real emulators:

```text
feed bytes → emulator A → damage → encode → feed to emulator B
assert A.grid == B.grid
```

Run it over recorded output from real full-screen programs (`vim`, `htop`, an agent
TUI) and over the adversarial cases: alt-screen switches, wide characters split by a
resize, scroll regions, and a resize between damage and encode. This is the single
most valuable test in the daemon, because everything else assumes the property it
checks.

### We **do** fake slow or non-deterministic collaborators

When testing `JanelaSession`, inject a fake `WorktreeServing` — the point of those
tests is the orchestration logic, not git. Same for clocks.

Four collaborators are fakes **by design**, because the thing under test is a
decision rather than a subprocess:

- **`AttentionDelivering`.** A recording fake, so every attention rule is a test:
  no delivery for the focused terminal, no delivery while frontmost, one delivery
  for four bells in 5 s. This is the whole reason policy and delivery were
  separated.
- **`ForgeServing`.** Returning canned JSON, plus the failure cases that matter
  more than the success one: binary missing, logged out, malformed output,
  timeout. Each must render as absence, never as an error the user sees.
- **The clock.** Coalescing windows, refresh intervals, teardown timeouts and the
  daemon's idle-exit grace period are all time-dependent, and a test that sleeps is
  a test that flakes.
- **`MessageTransport`, but only in `JanelaClient`.** Client tests drive an in-memory
  transport so reconnect, backoff and mirror-divergence cases are deterministic. The
  daemon side still uses a real socket, so the pairing is covered somewhere — faking
  both sides would test nothing.

---

## What each layer should assert

### Domain rules

Encode **product decisions**, so that reversing one breaks a test. The existing
`SessionBackingTests` is the model:

- a standalone session has no project, no repository and no worktree
- a project-directory session never owns its directory — it is the user's checkout
- both worktree ownerships expose their binding uniformly
- only Janela-created (`.managed`) worktrees may be deleted from disk

That last one is a safety rule stated as a test. If someone later makes adopted
worktrees deletable, they must consciously delete a test that says why not.

### Layout algebra

`SessionLayout` is the one piece of pure logic with real complexity, and every
constraint it enforces is a test:

- splitting a pane keeps every existing terminal id present, exactly once
- closing a terminal promotes its sibling; closing the last one in a tab closes the
  tab; closing the last tab leaves an empty layout, and the session keeps it
- a layout referencing a terminal that no longer exists is **repaired on load**,
  not rejected — assert the session opens
- depth beyond 6 and fractions outside `0.05...0.95` are refused or clamped

Round-trip every one of these through `Codable`. A layout that survives the
algebra but not the database is still a bug the user sees.

### Migrations

Every migration needs a test. Two kinds:

1. **Forward from the previous version.** Open a database at version N−1, migrate,
   assert the data survived. This is the test that stops us destroying a user's
   session list.
2. **Cascade rules**, because they encode product rules. `MigrationTests` asserts
   that deleting a project deletes its sessions, that deleting a session deletes
   its terminals, and that a standalone session survives everything except its own
   deletion.

Never edit a shipped migration. Add a new one and a new test. (`v1-initial` was
rewritten once, before release, when the domain model changed. That exception is
spent.)

### Concurrency and resource ownership

The bugs that will actually hurt are lifecycle bugs, so test them explicitly:

- closing a terminal terminates its child, including grandchildren
- closing a session terminates every terminal in every one of its tabs, including
  panes the user never looked at
- a terminal that exits while unfocused still records `hasUnseenAttention`
- the read path applies back-pressure rather than growing without bound
- closing the fd in the cleanup handler, not before, so no `EV_VANISHED`
- a `.sessionTeardown` command that never exits is abandoned at its timeout, and
  deletion still completes

### The daemon boundary

Every item here is a failure mode that did not exist before the split, which makes
this the list most likely to be under-tested:

- **The client disconnects and the terminals keep running.** The headline promise,
  and the first daemon test to write: start a terminal, drop the connection,
  reconnect, assert the same pid and an intact screen.
- **Reattach is a screen, not a replay.** Attach late to a terminal that has produced
  megabytes; assert the client receives one repaint bounded by grid size, not the
  history.
- **Two clients see the same screen**, and the PTY is sized to the smaller viewport.
- **A peer with the wrong uid is refused.** Awkward to arrange and worth doing once.
- **Version skew refuses politely.** An old handshake is rejected, the daemon stays
  up, and its terminals are untouched. Killing sessions on a version mismatch is the
  worst bug this system can have.
- **Frame boundaries.** A frame split across reads, two frames in one read, a length
  prefix past the bound, a connection that dies mid-frame.
- **A stalled client does not stall the daemon.** Stop reading on one connection;
  assert the others keep receiving and queues stay bounded.
- **Idle exit.** No clients and no live terminals exits after the grace period; one
  live terminal prevents it indefinitely.

### UI

Test presentation *logic*, not rendering. If a view has logic worth testing, that
logic probably belongs in an `@Observable` store where it can be tested directly.
Snapshot tests are not currently used; they tend to fail on OS updates for reasons
unrelated to correctness.

**Where a client test lives (current stack).** `@janela/ui` is internally
Feature-Sliced ([`architecture.md`](architecture.md) § Inside `@janela/ui`), and a
test is colocated with its subject *inside the slice or segment that owns it*:
`pages/settings/model/draft-save.test.ts` beside `draft-save.ts`, not in a `tests/`
tree of its own. Two rules follow from the gate rather than from taste:

- **Steiger lints test files too.** A test may not sidestep a slice's or a shared
  segment's public API either — it imports `../../../shared/model/index.ts`, never
  a file inside it — and it may not reach into the other page. A claim that needs
  both screens is a claim about the app layer, and belongs there or in the shared
  chrome both screens compose.
- **Fakes live in `shared/lib/test-fakes`.** The domain values, the recording
  ports and the two `ClientEnvironment` builders are one boundary with one
  `index.ts`, below every page, so a test never builds a second version of the
  mirror. They are not re-exported from the package's `index.ts`: nothing ships
  them.

---

## Performance tests

Budgets live in [`performance.md`](performance.md). They are not yet enforced
automatically; when a harness lands, start with:

1. Cold launch under 250 ms.
2. Sustained ≥ 100 MB/s terminal throughput with bounded memory.
3. 40 idle sessions under the memory budget.
4. **Socket traffic during a flood tracks frame rate, not throughput.** Cheap to
   assert, and it catches the failure that would quietly undo the daemon's main
   performance benefit.

Until then, record before/after numbers in the PR when changing anything on those
paths.

---

## Writing a good test here

- **Name the behaviour, not the method.** `test("only Janela-created worktrees may
  be deleted from disk")` beats `test("ownsItsDirectory")`.
- **One reason to fail.** If the name needs "and", split it.
- **Assert on outcomes, not calls.** `expect(worktreeExists).toBe(true)` beats
  "verify `createWorktree` was called once".
- **A test for a bug reproduces the bug first.** Watch it fail, then fix it.
  Otherwise you have not proven the test covers the fix.
- **The test name carries what a comment used to.** `oxslop/no-comments`
  applies to `*.test.ts` as well, so a fact about why a case exists belongs in
  the `test("…")` string, not above it.
- **Blank lines between runs of `expect()` are required.** `expect-padding` is
  on for test files and is autofixable — run `bunx --bun oxlint --fix` rather
  than placing them by hand.
- **Tests may assert what production code may not.** `!` and `console` are
  allowed there, and so is `as T` without a `SAFETY:` justification: a fixture
  branding a literal is stating the test's premise, not claiming an invariant.
  Every other oxslop rule applies to tests exactly as it does to source.
