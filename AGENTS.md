# AGENTS.md

Instructions for coding agents and human contributors working in this repository.
Read this before your first change. It is short on purpose.

---

## What Janela is

A native macOS **agentic IDE**: a terminal-first workspace manager for developers
who run coding agents and CLI tools.

The one-sentence model: **a workspace is a named directory with terminals in it.**
Git worktrees are one way a workspace's directory comes to exist — not the point
of the app.

If you are about to write code that contradicts that sentence, stop and read
[`docs/product.md`](docs/product.md) first.

---

## Commands

Everything is a `make` target. Do not invent new invocations.

| Command | What it does | When |
| --- | --- | --- |
| `make bootstrap` | Install tooling, resolve deps, generate the project | Once, first time |
| `make build` | Build all modules via SwiftPM | Constantly — takes seconds |
| `make test` | Run all module tests | After every change |
| `make lint` | swift-format + SwiftLint, non-mutating | Before committing |
| `make format` | Fix formatting in place | When `make lint` complains |
| `make check` | `lint` + `test` — exactly what CI runs | Before pushing |
| `make generate` | Regenerate `Janela.xcodeproj` from `project.yml` | After touching `project.yml` |
| `make app-build` | Build the real `.app` bundle | Only when you need the bundle |

**Prefer `make build` / `make test` over Xcode.** All logic lives in
`Packages/JanelaKit`, which builds without an Xcode project in a few seconds.
`xcodebuild` is minutes slower and you rarely need it.

---

## Repository layout

```text
App/Janela/            Thin app shell. ONE Swift file. Do not grow it.
Packages/JanelaKit/    All logic, as layered modules. Your work goes here.
docs/                  Architecture, decisions, conventions. Read before designing.
docs/decisions/        ADRs. Read the relevant one before changing a decision.
docs/research/         Primary-source research backing the ADRs.
scripts/               Implementations behind the make targets.
project.yml            Source of truth for the Xcode project (which is generated).
```

---

## The layering rule

Modules depend **downward only**. This is enforced by the compiler through target
dependencies in `Packages/JanelaKit/Package.swift`.

```text
JanelaSupport      logging, signposts, errors            (no dependencies)
    ↓
JanelaCore         domain types. Pure. No I/O.
    ↓
JanelaGit          git, by shelling out
JanelaPTY          pseudo-terminals and child processes   (the hot path)
JanelaPersistence  GRDB/SQLite store and migrations
    ↓
JanelaTerminal     PTY + emulator = a live session
    ↓
JanelaWorkspace    workspace lifecycle. The brain. No UI.
    ↓
JanelaDesign       tokens and reusable controls
JanelaUI           SwiftUI views
    ↓
JanelaApp          composition root
```

**If you need an upward reference, you need a protocol in the lower layer
instead.** Adding a dependency edge that points sideways or upward is a design
change: write it down in `docs/decisions/` first.

Two rules that catch most mistakes:

- Nothing above `JanelaTerminal` may `import SwiftTerm`. The emulator is swappable
  and the size of that seam is the cost of swapping it.
- Nothing in `JanelaWorkspace` or below may `import SwiftUI`.

---

## Non-negotiables

These come from the product thesis. Violating one is not a style disagreement, it
is a change of direction that needs an ADR.

1. **Worktree-aware, not worktree-centric.** There is one `Workspace` type and one
   creation entry point. Do not add a parallel "worktree" list, screen, or type.
2. **Never reimplement the user's tools.** Janela starts `claude`, it does not wrap
   it, parse its output, or model its tasks. Same for git beyond worktree
   plumbing, and for the shell.
3. **The terminal owns the keyboard.** Do not add key bindings that shadow what a
   TUI expects. `Ctrl-anything` belongs to the running program.
4. **Laziness is a feature.** A configured session that has not been started costs
   nothing. Do not eagerly spawn processes, read files, or build emulators.
5. **No unbounded buffers.** Terminal output is effectively infinite. Anything that
   accumulates it in memory must have a documented bound.
6. **Errors are either shown or logged, never both raw.** User-facing text goes
   through `UserFacingError`. Raw stderr never lands in a dialog headline.
7. **Never log terminal traffic**, command output, file contents, or environment
   values. It is the user's private data.

---

## Conventions that matter

- **Swift 6 language mode, strict concurrency.** No `@preconcurrency` escapes
  without a comment explaining the plan to remove it.
- **`any` on existentials** is required (`ExistentialAny` is on).
- **Explicit imports** are required for the module defining a member
  (`MemberImportVisibility` is on) — if the compiler asks for `import OSLog`, add it.
- **No `try!`, no force unwraps** in shipped code. The linter enforces this.
- **No `print()`.** Use the `Log` categories in `JanelaSupport`.
- **Dependency injection through `init`.** There is no singleton graph and no
  `.shared`. The composition root is `AppEnvironment.live()`.
- **Doc comments explain *why*.** The signature already says what. `swift-format`
  validates `- Parameters:`/`- Returns:`/`- Throws:` completeness.

Full details: [`docs/conventions.md`](docs/conventions.md).

---

## Testing

- Tests use **swift-testing** (`@Test`, `#expect`), not XCTest.
- `swift test` runs in **parallel**. Never write to a fixed path; use
  `TemporaryDirectory` and `GitFixture` from `JanelaTestSupport`.
- Git behaviour is tested against **real repositories** in temp directories. We do
  not mock git — a mock would only prove our assumptions.
- Note `#expect` cannot swallow a `try`. Hoist the throwing call into a `let`
  first, then assert on the value.

Full details: [`docs/testing.md`](docs/testing.md).

---

## Before you finish

Run `make check`. It must pass. Then confirm:

- [ ] Did you add a dependency edge? It must point downward.
- [ ] Did you add a concept a user has to learn? Justify it against
      [`docs/product.md`](docs/product.md) § Non-goals.
- [ ] Did you change an architectural decision? Add or amend an ADR in
      `docs/decisions/`.
- [ ] Does anything you added allocate per-byte or per-frame on the terminal path?
      Check the budgets in [`docs/performance.md`](docs/performance.md).

---

## Current state

The repository is **scaffolded, not implemented**. It builds, launches, and passes
its tests, but the substance is `TODO`. Search for `TODO:` to find the seams —
they are placed deliberately, and each one has a doc comment describing what
belongs there.

Start with [`docs/development.md`](docs/development.md) § First tasks.
