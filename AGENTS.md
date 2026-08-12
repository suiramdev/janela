# AGENTS.md

Instructions for coding agents and human contributors working in this repository.
Read this before your first change. It is short on purpose.

---

## What Janela is

A native macOS **terminal session manager**: you spawn and arrange terminal
sessions, and the app makes switching between them cost nothing.

The one-sentence model: **a session is a directory with terminals in it, and a
project is where sessions come from.**

The one-sentence architecture: **a daemon owns the sessions; the app is one of its
clients.**

```text
Project          collapsible in the sidebar — a repository or folder you added
  └─ Session     a button — one working directory, one or more terminals
       └─ Terminal   a shell, an agent, a dev server; split and tabbed
```

A session may stand alone, with no project at all. A session inside a project may
run in the project's own directory (*simple*) or in a git worktree Janela created
for it (*worktree-backed*). Worktrees are one way a session's directory comes to
exist — not the point of the app.

Terminals run inside `janelad`, a per-user daemon, so they survive the window
closing. The app renders; the daemon runs things. A future CLI and a future phone
client are more clients of the same socket — see
[`docs/decisions/0015-daemon-owned-sessions.md`](docs/decisions/0015-daemon-owned-sessions.md).

If you are about to write code that contradicts that, stop and read
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
                 JanelaSupport      logging, signposts, errors, subprocess
                       ↓
                 JanelaCore         domain types. Pure. No I/O.
                       ↓
                 JanelaProtocol     wire messages, framing, handshake
                  ↙         ↘
     ==== daemon ====        ==== client ====
     JanelaGit               JanelaClient      connection, mirror, attention policy
     JanelaPTY                   ↓
     JanelaPersistence       JanelaDesign      tokens and reusable controls
     JanelaForge (planned)   JanelaTerminalUI  the SwiftTerm-backed surface
         ↓                       ↓
     JanelaTerminal          JanelaUI          SwiftUI views
         ↓                       ↓
     JanelaSession           JanelaApp         composition root, notifications
         ↓
     JanelaDaemon  →  janelad (executable)
```

**If you need an upward reference, you need a protocol in the lower layer
instead.** Adding a dependency edge that points sideways or upward is a design
change: write it down in `docs/decisions/` first.

Four rules that catch most mistakes:

- **No client module may import a daemon module, or vice versa.** They meet only at
  `JanelaCore` and `JanelaProtocol`. This is what makes a CLI possible without a
  refactor, and why `JanelaUI` cannot spawn a process even by accident.
- Only `JanelaTerminal` (daemon, headless) and `JanelaTerminalUI` (client, the view)
  may `import SwiftTerm`. Two seams, one library, one rule.
- Nothing in `JanelaSession` or below may `import SwiftUI`, `AppKit`, or
  `UserNotifications`. The daemon detects attention, the client decides, the app
  delivers.
- `JanelaGit` and `JanelaForge` are peers and must never import each other. Shared
  subprocess plumbing lives in `JanelaSupport`.

---

## Non-negotiables

These come from the product thesis. Violating one is not a style disagreement, it
is a change of direction that needs an ADR.

1. **Worktree-aware, not worktree-centric.** There is one `Session` type and one
   creation entry point. Do not add a parallel "worktree" list, screen, or type.
2. **Two levels, and no more.** Projects contain sessions; sessions contain
   terminals. No nested projects, no session groups, no folders, no tags.
3. **Never reimplement the user's tools.** Janela starts `claude`, it does not wrap
   it, parse its output, or model its tasks. Same for git beyond worktree
   plumbing, for `gh`/`glab` beyond reading state, and for the shell.
4. **The terminal owns the keyboard.** Do not add key bindings that shadow what a
   TUI expects. `Ctrl-anything` belongs to the running program — including split
   and tab navigation, which uses `⌘`-based chords only.
5. **Laziness is a feature.** A configured terminal that has not been started costs
   nothing. Do not eagerly spawn processes, read files, build emulators, or refresh
   forge state.
6. **The daemon is the source of truth; clients render a mirror.** A client never
   computes state it could ask for, and never writes state it did not receive. The
   app has no privileged path — if the CLI could not do it through the protocol,
   neither may the app.
7. **Never kill a user's terminals to make our lives easier.** Not on version skew,
   not on a failed handshake, not on app quit. Terminating them is always an
   explicit user choice with a stated cost.
8. **Nothing blocks across the socket.** The client renders its last known state
   when the daemon is slow or gone; the daemon never waits on a client. Both
   directions have bounded queues.
9. **No unbounded buffers.** Terminal output is effectively infinite. Anything
   accumulating it in memory needs a documented bound — scrollback, per-client
   output queues, `.worktreeinclude` copies, automation output, and any frame
   length read off a socket.
10. **Errors are either shown or logged, never both raw.** User-facing text goes
    through `UserFacingError`. Raw stderr never lands in a dialog headline. A
    missing or logged-out `gh` is silence, not an error banner.
11. **Never log terminal traffic**, command output, file contents, notification
    bodies, or environment values. It is the user's private data — and the daemon
    writes to the same system log the app does.
12. **Automation is visible.** Project commands run in a real terminal the user can
    watch and scroll back through. Nothing run on the user's behalf happens in a
    hidden process.

---

## Vocabulary

The words are load-bearing; UI copy and code use the same ones.

| Say | Not |
| --- | --- |
| project | repository, workspace, group, folder |
| session | workspace, worktree, tab, window |
| terminal | pane, shell, tab, session |
| launch profile | agent, command, tool, preset |
| automation command | hook, script, task, job |
| daemon, `janelad` | server, backend, service, agent |
| client | frontend, UI (when you mean the process) |
| attach / detach | connect, open, subscribe (when you mean one terminal) |

**"Workspace" is retired.** It used to be this app's central noun; it is now a
synonym for nothing. If a sentence wants it, that sentence has not decided whether
it means a project or a session. Full table in
[`docs/domain-model.md`](docs/domain-model.md) § Vocabulary.

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
  not mock git — a mock would only prove our assumptions. The same goes for
  `.worktreeinclude`, which is tested by creating a real worktree and looking at
  what landed in it.
- Automation, attention policy and forge state are tested with **fakes**, because
  the logic under test is the decision, not the subprocess.
- Note `#expect` cannot swallow a `try`. Hoist the throwing call into a `let`
  first, then assert on the value.

Full details: [`docs/testing.md`](docs/testing.md).

---

## Before you finish

Run `make check`. It must pass. Then confirm:

- [ ] Did you add a dependency edge? It must point downward, and must not cross the
      daemon/client line except through `JanelaCore` or `JanelaProtocol`.
- [ ] Did you change the wire protocol? Version it, and say what an older peer does.
- [ ] Did you add a concept a user has to learn? Justify it against
      [`docs/product.md`](docs/product.md) § Non-goals — the budget is four nouns.
- [ ] Did you use the word "workspace"? Replace it with project or session.
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
