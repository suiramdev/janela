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

What is a stub: the PTY, the terminal session, git operations, workspace
persistence, and essentially all UI. Every stub has a doc comment describing what
belongs there. `grep -rn "TODO:" Packages/` is a work queue.

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

GRDB records and queries for the four tables. Round-trip tests.

### 4. `JanelaTerminal` — the emulator seam

Implement `TerminalEmulating` over SwiftTerm. Expect to need
`@preconcurrency import SwiftTerm` — it is Swift 5 language mode
([ADR 0003](decisions/0003-concurrency-model.md)). Wire `TerminalSession.start()`
to the PTY and feed the emulator.

### 5. `JanelaWorkspace` — lifecycle

`WorkspaceStore.load`, `createWorkspace`, `removalPlan`, `removeWorkspace`. Also
`ShellEnvironment` resolution — the login-shell `argv[0]` trick is what stops
"claude: command not found".

Tests with an in-memory database and a fake `WorktreeServing`.

### 6. `JanelaUI` — the actual app

Sidebar, tab strip, and an `NSViewRepresentable` wrapping the terminal view.

---

## Debugging

```bash
# Live logs
log stream --predicate 'subsystem == "sh.janela.Janela"' --level debug

# Recent logs
log show --predicate 'subsystem == "sh.janela.Janela"' --last 10m

# Inspect the database
sqlite3 ~/Library/Application\ Support/sh.janela.Janela/janela.sqlite

# Start from a clean slate
rm -rf ~/Library/Application\ Support/sh.janela.Janela
```

Profiling: see [`performance.md`](performance.md) § How to measure.

---

## Committing

`make check` must pass. Beyond that:

- Write commit messages that explain **why**. The diff shows what.
- Changing an architectural decision means adding or superseding an ADR, in the
  same PR.
- Adding a user-visible concept means justifying it against
  [`product.md`](product.md) § Non-goals.
