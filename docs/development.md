# Development

Getting set up, working day to day, and what to build first.

---

## Requirements

| Thing | Version | Why |
| --- | --- | --- |
| macOS | 15.0+ | Deployment target ([ADR 0002](decisions/0002-macos-deployment-target.md)) |
| Xcode | 26.0+ | Swift 6.2 tools, bundled `swift-format` |
| XcodeGen | any recent | Generates `Janela.xcodeproj` ([ADR 0001](decisions/0001-project-generation.md)) |
| SwiftLint | any recent | Optional locally, required in CI |

## Setup

```bash
git clone <repo> janela && cd janela
make bootstrap
```

`bootstrap` verifies Xcode, installs XcodeGen via Homebrew if missing, resolves
package dependencies, and generates the Xcode project. It is safe to re-run.

Verify:

```bash
make test     # 6 tests, well under a second
make lint     # clean
```

---

## The loop

**Work in the package, not in Xcode.**

```bash
make build    # seconds
make test     # seconds
make lint     # before committing
make check    # lint + test, exactly what CI runs
```

`Packages/JanelaKit` builds without an Xcode project. `xcodebuild` is minutes
slower and you only need it when you want the actual `.app`:

```bash
make app-build
make app-run
```

When you need Xcode itself — SwiftUI previews, Instruments, the view debugger:

```bash
make open     # regenerates the project first, then opens it
```

### Two things that will bite you

1. **`make generate` after editing `project.yml`.** Otherwise Xcode is looking at
   a stale project. `make open` does it for you; running `xcodebuild` directly does
   not.
2. **Never commit `Janela.xcodeproj`.** It is generated and gitignored, and CI
   fails if one appears.

---

## Where things live

```text
App/Janela/JanelaAppMain.swift        The @main shim. One file. Keep it that way.
Packages/JanelaKit/Sources/           Every module. Your work is here.
Packages/JanelaKit/Tests/             Tests, one target per module.
docs/decisions/                       ADRs — read before changing a decision.
docs/research/                        Primary-source research behind the ADRs.
```

The modules divide into three groups, and which group a file belongs to decides
what it may import:

```text
shared    JanelaSupport  JanelaCore  JanelaProtocol
daemon    JanelaGit  JanelaPTY  JanelaPersistence  JanelaTerminal
          JanelaSession  JanelaDaemon  →  janelad
client    JanelaClient  JanelaDesign  JanelaTerminalUI  JanelaUI  JanelaApp
```

Read [`architecture.md`](architecture.md) for the module map and the layering rule
before adding a file, and `AGENTS.md` for the short version.

---

## Current state

The repository is **scaffolded, not implemented**. It builds, launches, and passes
its tests, but the behaviour is `TODO`.

What exists and works:

- The full module graph, with compiler-enforced layering.
- Domain types, with tests pinning the product rules.
- The database with its first migration, tested.
- The app target: builds, signs (ad-hoc), launches, shows an empty state.
- `make` targets and CI.

What is a stub: the PTY, the live terminal, git operations, project and session
persistence, and essentially all UI. Not yet present at all: `JanelaForge`,
automation, `.worktreeinclude`, notifications and the layout algebra — all of them
designed in [`domain-model.md`](domain-model.md) and their ADRs, none of them
written. Every stub has a doc comment describing what belongs there.
`grep -rn "TODO:" Packages/` is a work queue.

---

## First tasks

Roughly dependency-ordered. Each is a reasonable PR.

### 1. `JanelaPTY` — make a process run

The foundation, and the highest-risk piece. `PseudoTerminal.init` currently throws.

Implement `openpty()` → `fork()` → child does `login_tty()`, `chdir`, `execve`.
**Read the doc comment first** — `posix_spawn` and `Foundation.Process` cannot give
a child a controlling terminal, and between `fork` and `exec` you may call only
async-signal-safe functions. Pre-marshal the `char **` arrays before forking.

Then `TerminalByteStream` over `DispatchIO`, with the water marks and the
one-successor-read rule from the doc comment.

Tests: spawn `/bin/echo`, read its output, assert exit code. Spawn `cat`, write,
read it back. Resize and assert `SIGWINCH`. Kill a process group with a
grandchild.

### 2. `JanelaGit` — worktree operations

`GitRunner.run`/`probe` over `Foundation.Process` (no PTY needed here), then
`WorktreeService`. Parse `git worktree list --porcelain -z` — use `-z`, because
worktree paths may contain newlines.

Tests use `GitFixture` against real repositories.

### 3. `JanelaPersistence` — records

GRDB records and queries for the tables in `v1-initial`: project, session,
terminal, launchProfile, automationCommand. Round-trip tests, plus the cascade
tests that encode product rules ([`testing.md`](testing.md) § Migrations).

### 4. `JanelaCore` — the layout algebra

Pure logic, no I/O, and the one piece of real complexity in the domain layer:
split, close-and-promote, focus traversal, depth and fraction validation, and
`Codable` round-tripping. Worth doing before the UI that consumes it, because every
rule in [ADR 0010](decisions/0010-terminal-layout.md) is testable in milliseconds
with no window server.

### 5. `JanelaTerminal` — the emulator seam

Implement `TerminalEmulating` over SwiftTerm. Expect to need
`@preconcurrency import SwiftTerm` — it is Swift 5 language mode
([ADR 0003](decisions/0003-concurrency-model.md)). Wire `LiveTerminal.start()`
to the PTY and feed the emulator.

### 6. `JanelaSession` — lifecycle

`ProjectStore` and `SessionStore`: `load`, `createSession`, `removalPlan`,
`removeSession`. Also `ShellEnvironment` resolution — the login-shell `argv[0]`
trick is what stops "claude: command not found".

Tests with an in-memory database and a fake `WorktreeServing`.

### 7. `JanelaProtocol` + `JanelaDaemon` — the socket

Framing first, because it is pure and every bug in it is cheap to find now and
expensive to find later: length-prefixed frames, bounded, with a `Hello` handshake.
Then a listener that accepts a connection, checks `LOCAL_PEERCRED`, and answers.

Tests bind a real socket in a `TemporaryDirectory` — keep the path short, `sun_path`
is 104 bytes ([ADR 0016](decisions/0016-daemon-protocol.md)).

### 8. `JanelaClient` — the mirror

Connect, handshake, subscribe, and turn `DaemonMessage.state` into the `@Observable`
stores the UI reads. Then reconnect with backoff, which is where the interesting
bugs are.

### 9. `JanelaUI` — the actual app

Sidebar (collapsible projects, standalone sessions above them), tab strip, split
view, and an `NSViewRepresentable` wrapping the terminal view from
`JanelaTerminalUI`.

### 10. The repaint encoder

Damage tracking to minimal escape sequences, in `JanelaTerminal`. Deliberately last:
it is the hardest piece, and a correct-but-dumb full repaint every frame is a valid
placeholder that makes everything above it work first. Test it with two emulators
and assert the grids match ([`testing.md`](testing.md)).

### Then, in any order

These are independent of each other and each is a reasonable PR on its own:

- **`.worktreeinclude`** in `JanelaGit` — one `git ls-files` call plus a
  `clonefile` copy with the bounds from
  [ADR 0013](decisions/0013-worktreeinclude.md). Test against a real repository.
- **Automation** in `JanelaSession` — an `AutomationRunner` that creates terminals
  with `role: .automation`. Most of the work is ordering and the teardown timeout,
  not process handling, because the terminal already does that.
- **Attention policy** in `JanelaSession` plus a nine-line
  `AttentionDelivering` adapter in `JanelaApp`
  ([ADR 0011](decisions/0011-notifications.md)). The policy is pure and should be
  exhaustively tested; the adapter is not worth testing.
- **`JanelaForge`** — a new target beside `JanelaGit`, `gh`/`glab` behind
  `ForgeServing`. Start with the failure paths; they are the common ones
  ([ADR 0012](decisions/0012-forge-integration.md)).

---

## Debugging

```bash
# Live logs from BOTH processes (they share a subsystem on purpose)
log stream --predicate 'subsystem == "sh.janela.Janela"' --level debug

# Just the daemon
log stream --predicate 'subsystem == "sh.janela.Janela"' --process janelad

# Recent logs
log show --predicate 'subsystem == "sh.janela.Janela"' --last 10m

# Inspect the database (the daemon owns it; read-only is polite)
sqlite3 -readonly ~/Library/Application\ Support/sh.janela.Janela/janela.sqlite

# Start from a clean slate
rm -rf ~/Library/Application\ Support/sh.janela.Janela ~/.janela
```

### The daemon

The footgun of this architecture: **an old `janelad` staying resident while you
iterate on a new one.** Symptoms are a handshake refusal, or worse, behaviour from
code you edited ten minutes ago.

```bash
make daemon-restart      # stop it; launchd starts the new one on next connect
pgrep -lf janelad        # is one running, and which binary is it?
lsof -U | grep janelad   # who is connected to the socket

# Run it in the foreground instead, for a debugger or plain stdout:
.build/debug/janelad --socket /tmp/janela-dev.sock --foreground
```

The socket lives at `~/.janela/run/janelad.sock`, not in Application Support — see
[ADR 0016](decisions/0016-daemon-protocol.md) for the `sun_path` reason.

A daemon holding live terminals will not exit on its own, which is correct and
occasionally inconvenient. `make daemon-restart` terminates them deliberately; that
is the same cost a user pays after an app update, so it is worth feeling.

Profiling: see [`performance.md`](performance.md) § How to measure.

---

## Committing

`make check` must pass. Beyond that:

- Write commit messages that explain **why**. The diff shows what.
- Changing an architectural decision means adding or superseding an ADR, in the
  same PR.
- Adding a user-visible concept means justifying it against
  [`product.md`](product.md) § Non-goals. The budget is four nouns: project,
  session, terminal, launch profile.
- Using the word "workspace" in code, copy or docs means you have not decided
  whether you mean a project or a session. Pick one.
- Changing the wire protocol means bumping its version and saying what an older
  peer does. "The user restarts the daemon" is an acceptable answer; silently
  killing their terminals is not.
