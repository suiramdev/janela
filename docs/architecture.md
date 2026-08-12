# Architecture

How Janela is put together, and why the seams are where they are.

Read [`product.md`](product.md) first — the structure below exists to serve that
thesis, and several choices only make sense in its light.

---

## Shape of the system

Janela is a single process. There is no daemon, no helper app, no local server,
and no IPC layer.

This is worth stating explicitly because the reference projects in this space
mostly *do* have one, usually because they are Electron apps that need a Node
process to touch the filesystem, or because they orchestrate long-running remote
work. Janela does neither: it is a native app that spawns child processes, and a
native app can just do that.

The cost is that sessions die when the app quits. That is an accepted trade for v1
— see [Session durability](#session-durability) below.

```text
┌─────────────────────────────────────────────────┐
│ Janela.app  (single process)                    │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │ JanelaApp — composition root, scenes      │  │
│  ├───────────────────────────────────────────┤  │
│  │ JanelaUI / JanelaDesign — SwiftUI         │  │
│  ├───────────────────────────────────────────┤  │
│  │ JanelaWorkspace — lifecycle, the "brain"  │  │
│  ├──────────────┬───────────────┬────────────┤  │
│  │ JanelaGit    │ JanelaTerminal│ Persistence│  │
│  │              │      ↓        │            │  │
│  │              │  JanelaPTY    │            │  │
│  ├──────────────┴───────────────┴────────────┤  │
│  │ JanelaCore — domain types (pure)          │  │
│  ├───────────────────────────────────────────┤  │
│  │ JanelaSupport — logging, errors           │  │
│  └───────────────────────────────────────────┘  │
└───────────┬─────────────────────┬───────────────┘
            │ posix_spawn + PTY   │ subprocess
            ▼                     ▼
     user's shell / agents      /usr/bin/git
```

---

## Modules

Defined in `Packages/JanelaKit/Package.swift`. Dependencies point downward only,
and the compiler enforces it — an illegal import is a build error, not a review
comment.

| Module | Owns | Must not |
| --- | --- | --- |
| `JanelaSupport` | `Log`, `Signpost`, `UserFacingError` | Know anything about the domain |
| `JanelaCore` | `Workspace`, `Repository`, `TerminalSessionDescriptor`, `LaunchProfile` | Perform I/O, import anything but Foundation |
| `JanelaGit` | Running `git`; worktree create/list/remove/safety | Leak command strings above its API |
| `JanelaPTY` | `PseudoTerminal`, `TerminalByteStream`, sizing, signals | Know about workspaces or UI |
| `JanelaPersistence` | GRDB store, schema, migrations | Contain business rules |
| `JanelaTerminal` | `TerminalSession`, `SessionRegistry`, the emulator seam | Be imported *through* — no `SwiftTerm` leaks upward |
| `JanelaWorkspace` | Workspace lifecycle, `ShellEnvironment`, removal planning | Import SwiftUI |
| `JanelaDesign` | Tokens, semantic colours, shared controls | Know what a workspace is |
| `JanelaUI` | Views and presentation state | Reach past `JanelaWorkspace` into Git/PTY |
| `JanelaApp` | Object graph, scenes, menu commands | Contain logic worth testing |

### Why one package with many targets

Rather than many packages, or one big module. Many packages means many
`Package.resolved` files and slow resolution; one module means the layering is a
convention rather than a rule. Targets in a single package give compiler-enforced
boundaries with none of the overhead. The app target links exactly one product,
`JanelaApp`, so internal reshuffling never touches `project.yml`.

---

## The seams that matter

Three boundaries carry most of the design risk. Each is deliberately narrow so
that replacing what is behind it stays affordable.

### 1. `TerminalEmulating` — the VT parser and renderer

`JanelaTerminal` defines a small protocol; a SwiftTerm-backed type implements it.
Nothing above `JanelaTerminal` may import SwiftTerm.

Terminal emulation is the part of this app most likely to need replacing —
performance ceilings, ligatures, graphics protocols, or simply SwiftTerm's
maintenance trajectory could each force the issue. The protocol is the price of
that option, and it is about a dozen methods.

See [`decisions/0004-terminal-engine.md`](decisions/0004-terminal-engine.md).

### 2. `GitRunning` — the git boundary

Everything git goes through a process runner taking an argument array. There is no
shell, so there is no quoting bug class. Higher layers speak in `GitWorktree` and
`WorktreeRemovalSafety`, never in command strings.

See [`decisions/0007-git-integration.md`](decisions/0007-git-integration.md).

### 3. `JanelaPTY` — the hot path

Deliberately isolated with no third-party dependencies and no domain knowledge, so
it can be profiled and stress-tested on its own. Everything about Janela's
performance story lives or dies here.

---

## Key flows

### Creating a workspace

There is exactly one public entry point, `WorkspaceStore.createWorkspace(_:)`,
taking a `WorkspaceCreationRequest` with four cases. Worktree creation is *one
case of that function*, not a separate feature.

```text
UI  →  WorkspaceStore.createWorkspace(.newBranch(repo, branch, …))
         │
         ├─ WorktreeService.createWorktree()  → git worktree add -b …
         ├─ persist Workspace(origin: .managedWorktree(binding))
         └─ create one TerminalSessionDescriptor (not started)
                                    │
                                    ▼
                       UI selects it; session starts lazily
```

If a second public creation method ever appears, the worktree-centric model has
crept back in.

### Starting a session

```text
TerminalSession.start()
   │
   ├─ resolve command      (LaunchProfile, or the login shell)
   ├─ resolve environment  (ShellEnvironment + JANELA_* vars)
   ├─ PseudoTerminal(configuration:)   → posix_spawn + login_tty
   ├─ TerminalByteStream               → DispatchIO, coalesced per frame
   └─ emulator.feed(bytes)             → one parse, one redraw per frame
```

The coalescing step is the difference between "fine" and "unusable" when a build
log is scrolling. See [`performance.md`](performance.md) § Terminal throughput.

### Detecting that something wants attention

Janela does not interpret agent output. It listens for terminal-level signals —
BEL, OSC 9, OSC 777, and OSC 133 prompt marks — surfaces them as
`TerminalEventSink` callbacks, and badges the session.

See [`decisions/0006-agent-activity-signals.md`](decisions/0006-agent-activity-signals.md).

---

## Concurrency model

Swift 6 language mode, strict concurrency, across every target.

- **UI and session state are `@MainActor`.** `TerminalSession`, `SessionRegistry`
  and `WorkspaceStore` are all main-actor `@Observable` classes. This is not
  laziness: they exist to drive views, and hopping actors to read a title is worse
  than the isolation it buys.
- **`PseudoTerminal` is an actor**, owning the file descriptor and child process.
- **The read loop does not hop per chunk.** Reads happen on a dedicated
  `DispatchIO` channel, are coalesced, and cross to the main actor at most once per
  frame. A per-read actor hop is the single easiest way to make this app slow.
- **`JanelaGit` and `JanelaPersistence` are `Sendable` value types / thread-safe
  classes**, called with `await` from the main actor and doing their work off it.

See [`decisions/0003-concurrency-model.md`](decisions/0003-concurrency-model.md).

---

## Persistence

A small SQLite database via GRDB at
`~/Library/Application Support/sh.janela.Janela/janela.sqlite`.

It holds workspaces, repositories, session descriptors, launch profiles. Kilobytes,
by design. Explicitly **not** stored: terminal scrollback (unbounded, private),
secrets (Keychain or the user's own shell config), and anything derivable from git
(we cache for display, but git is always the source of truth and we re-read rather
than reconcile).

See [`decisions/0005-persistence.md`](decisions/0005-persistence.md).

---

## Session durability

When Janela quits, its child processes die. This is the honest consequence of the
single-process design.

Mitigations available without changing that design:

- Session *descriptors* persist, so tabs come back in the right places, idle.
- The user can run `tmux`/`zellij` inside a session if they want true durability —
  and it works, because we do not interfere with the terminal.

Making sessions survive app restarts requires a helper daemon that owns the PTYs,
which is a significant architectural change. It is a plausible v2, and it should be
an ADR that supersedes this section rather than an incremental leak.

---

## What is deliberately absent

- **No dependency-injection container.** Constructor injection from
  `AppEnvironment.live()`. If wiring becomes painful, the object graph is too big.
- **No coordinator/router layer.** SwiftUI scenes and `NavigationSplitView` are
  sufficient for a two-pane app.
- **No view models per view.** `@Observable` stores hold state; views read them.
  A view model that only forwards is noise.
- **No plugin API.** See [`product.md`](product.md) § Non-goals.
