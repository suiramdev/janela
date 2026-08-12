# Architecture

How Janela is put together, and why the seams are where they are.

Read [`product.md`](product.md) first — the structure below exists to serve that
thesis, and several choices only make sense in its light.

---

## Shape of the system

**Two processes.** A daemon owns everything durable; the app is one of its clients.

```text
┌──────────────────────────────┐        ┌──────────────────────────────────────┐
│ Janela.app                   │        │ janelad  (one per user, launchd)     │
│                              │        │                                      │
│  JanelaApp — scenes, menus,  │        │  JanelaDaemon — listener, sessions   │
│              notifications   │        │  JanelaSession — the brain           │
│  JanelaUI / JanelaDesign     │        │  JanelaTerminal — PTY + emulator     │
│  JanelaTerminalUI — renderer │        │  Git │ PTY │ Persistence │ Forge     │
│  JanelaClient — mirror       │        │                                      │
└──────────────┬───────────────┘        └──────┬──────────────┬────────────────┘
               │                               │              │
               │   unix socket, framed         │ posix_spawn  │ subprocess
               └───────────────────────────────┤ + PTY        ▼
                                               ▼         git / gh / glab
                                        shell / agents
```

Everything both sides share — `JanelaCore` (domain types) and `JanelaProtocol`
(wire format) — is pure, `Sendable`, and links into both.

This reverses the previous design, which was deliberately a single process. The
reasoning for the reversal, and the honest cost of it, is
[`decisions/0015-daemon-owned-sessions.md`](decisions/0015-daemon-owned-sessions.md).
The short version: sessions have to outlive the window, and a CLI and a remote
client both need something that is not a window to talk to.

### What the split buys, concretely

- **Closing the app costs nothing.** Agents keep working, dev servers keep serving.
- **The app cannot spawn a process.** `JanelaUI` no longer links Git, PTY,
  Persistence or Terminal. The capability is not merely discouraged; it is absent.
- **Floods stop at the daemon.** See [Terminal data flow](#terminal-data-flow).
- **The CLI and a phone are clients**, not features. Same socket, same messages.

### What it costs

- A repaint encoder we own (below), which is the hard part.
- Version skew between app and daemon, with a user-facing story
  ([0016](decisions/0016-daemon-protocol.md), [0017](decisions/0017-daemon-lifecycle.md)).
- Two signed binaries in one bundle ([0008](decisions/0008-sandboxing-and-distribution.md)).
- State that can be *stale* as well as wrong, which the compiler cannot check.

---

## Modules

Defined in `Packages/JanelaKit/Package.swift`. Dependencies point downward only,
and the compiler enforces it — an illegal import is a build error, not a review
comment.

### Shared

| Module | Owns | Must not |
| --- | --- | --- |
| `JanelaSupport` | `Log`, `Signpost`, `UserFacingError`, `ProcessRunning` | Know anything about the domain |
| `JanelaCore` | `Project`, `Session`, `TerminalDescriptor`, `SessionLayout`, `AutomationCommand`, `LaunchProfile` | Perform I/O, import anything but Foundation |
| `JanelaProtocol` | Frames, messages, handshake, transport seam | Know how anything is *implemented* on either side |

### Daemon side

| Module | Owns | Must not |
| --- | --- | --- |
| `JanelaGit` | Running `git`; worktree create/list/remove/safety; `.worktreeinclude` | Leak command strings above its API |
| `JanelaPTY` | `PseudoTerminal`, `TerminalByteStream`, sizing, signals | Know about sessions or clients |
| `JanelaPersistence` | GRDB store, schema, migrations | Contain business rules |
| `JanelaForge` *(planned)* | Running `gh` / `glab` | Own credentials, or block a request |
| `JanelaTerminal` | `LiveTerminal`, authoritative grid, damage tracking, repaint encoding | Be imported *through* — no `SwiftTerm` leaks upward |
| `JanelaSession` | Project and session lifecycle, automation, `ShellEnvironment`, removal planning | Import SwiftUI, or know a socket exists |
| `JanelaDaemon` | Listener, connections, subscriptions, peer-credential checks | Contain product logic that belongs in `JanelaSession` |
| `janelad` (executable) | Socket activation, signals, idle exit | Contain anything testable |

### Client side

| Module | Owns | Must not |
| --- | --- | --- |
| `JanelaClient` | Connection, reconnect, mirrored `@Observable` state, attention policy | Import anything daemon-side |
| `JanelaDesign` | Tokens, semantic colours, shared controls | Know what a session is |
| `JanelaTerminalUI` | `TerminalRendering`, the SwiftTerm-backed view | Own a PTY or a child process |
| `JanelaUI` | Views and presentation state | Reach past `JanelaClient` |
| `JanelaApp` | Object graph, scenes, menus, `UNUserNotificationCenter`, `SMAppService` | Contain logic worth testing |

*Planned* means designed and documented but not yet in `Package.swift`.

### The rule that replaced "no SwiftUI below the brain"

`JanelaSession` still may not import SwiftUI. But the sharper rule now is
**directional**: no client module may import a daemon module, and vice versa. They
meet only at `JanelaProtocol`. That is what makes the CLI possible without
refactoring, and it is checked the same way as everything else — by the compiler,
because the dependencies are simply not declared.

---

## The seams that matter

Five boundaries carry the design risk. Each is deliberately narrow.

### 1. `MessageTransport` — how bytes reach the daemon

A protocol over "deliver these frames, give me those frames". A Unix socket
implements it today; a TLS connection implements it later. Nothing above it knows
which. See [`decisions/0016-daemon-protocol.md`](decisions/0016-daemon-protocol.md).

### 2. `TerminalEmulating` — the VT parser and the grid (daemon)

Feed bytes, resize, ask for damage since a revision, serialise the grid for a
newly-attached client, snapshot text. SwiftTerm-backed, and nothing above
`JanelaTerminal` may import SwiftTerm.

### 3. `TerminalRendering` — the surface (client)

Feed bytes, resize, focus, selection. Also SwiftTerm-backed, in `JanelaTerminalUI`,
and equally sealed. Two seams, one library, one rule — see
[`decisions/0004-terminal-engine.md`](decisions/0004-terminal-engine.md).

### 4. `GitRunning` — the git boundary

Everything git goes through a process runner taking an argument array. No shell, so
no quoting bug class. Also owns `.worktreeinclude` resolution, because the honest
implementation of "which ignored files match these patterns" is `git ls-files`, not
a matcher we wrote. See [`decisions/0013-worktreeinclude.md`](decisions/0013-worktreeinclude.md).

### 5. `AttentionDelivering` — notification policy vs. delivery

The daemon detects and emits a fact. `JanelaClient` applies policy, because only a
client knows what is focused. `JanelaApp` delivers, because
`UNUserNotificationCenter` is an app-level API. See
[`decisions/0011-notifications.md`](decisions/0011-notifications.md).

---

## Terminal data flow

The single most important path in the system, and the one the daemon changed most.

```text
child process
    │ raw bytes, up to 100 MB/s
    ▼
PseudoTerminal ─► TerminalByteStream        DispatchIO, coalesced, back-pressured
    │
    ▼
LiveTerminal's emulator  (daemon)           authoritative grid + bounded scrollback
    │                                        damage tracked per cell
    │ once per frame, per attached client:
    │ encode the shortest escape sequence that repaints what changed
    ▼
socket frame (raw kind)                     bounded by frame rate, not throughput
    ▼
TerminalRendering  (client)                 an ordinary terminal view, fed bytes
    ▼
pixels
```

Why encode escape sequences rather than ship a grid: every client already knows how
to consume them. SwiftTerm on macOS, xterm.js on the web, a real terminal for the
CLI. We invent no rendering format and no client needs to learn one.

Why this is *faster* than the in-process design it replaced: a `yes` flood produced
100 MB/s that the UI had to survive. Now it produces 100 MB/s into an emulator in a
process with no UI, and roughly 60 screens per second of changed cells to the app.

**Attach** is the same encoder run against the whole grid instead of the damage set,
which is why reconnecting after an hour costs one screen and is correct for
full-screen TUIs rather than lucky.

---

## Key flows

### Creating a session

One public entry point, `SessionStore.createSession(_:)` in the daemon, reached by
clients through one message. Worktree creation is one case of it.

```text
app  →  ClientMessage.createSession(.newWorktree(project, branch, …))
          │  socket
          ▼
        SessionService (JanelaSession, in the daemon)
          ├─ WorktreeService.createWorktree()   → git worktree add -b …
          ├─ WorktreeInclude.copy()             → git ls-files -o -i --exclude-from
          ├─ persist Session(backing: .worktree(binding))
          ├─ AutomationRunner.run(.worktreeCreated)  → a terminal, visible
          ├─ AutomationRunner.run(.sessionStart)     → a terminal, visible
          └─ create the user's TerminalDescriptor (not started)
                  │
                  ▼  DaemonMessage.state(…) to every subscriber
        every attached client updates, including ones that did not ask
```

Nothing blocks: progress is published as state updates, and the requesting client
may disconnect mid-flight without affecting the outcome.

### Starting a terminal

```text
LiveTerminal.start()                        in the daemon
   ├─ resolve command      (LaunchProfile, or the login shell)
   ├─ resolve environment  (ShellEnvironment + JANELA_* vars)
   ├─ PseudoTerminal(configuration:)   → posix_spawn + login_tty
   ├─ TerminalByteStream               → DispatchIO, coalesced per frame
   └─ emulator.feed(bytes)             → grid updated, damage recorded
```

### Attaching and reattaching

```text
client: attach(terminalID, viewport: 120×40)
daemon: resize the PTY to min(all attached viewports)      ← 0016
        serialise the grid → repaint bytes → this client only
        thereafter: damage-encoded frames to all attached clients
```

### Connection loss

The client renders its last known mirror and marks it stale. It reconnects with
backoff, re-subscribes, and re-attaches — which produces a fresh full repaint, so
recovery needs no special case. Terminals were never affected: they are in the
daemon, and they kept running.

---

## Concurrency model

Swift 6 language mode, strict concurrency, across every target.

- **The daemon has no main actor.** Per-terminal serial queues for parsing;
  actors for the session registry and connection table.
- **The client's UI-facing state is `@MainActor`** — `SessionStore`, `ProjectStore`
  and friends are `@Observable` mirrors fed by the connection.
- **The read path never hops per chunk**, and now never crosses a process boundary
  per chunk either.
- **Per-client back-pressure.** A client that stops reading slows only its own
  stream.

See [`decisions/0003-concurrency-model.md`](decisions/0003-concurrency-model.md).

---

## Persistence

SQLite via GRDB at
`~/Library/Application Support/sh.janela.Janela/janela.sqlite`, opened by **the
daemon and nothing else**. Clients read state over the protocol; a client module
that imports `JanelaPersistence` is a layering bug.

The socket lives at `~/.janela/run/janelad.sock` instead, for an unglamorous
reason: `sockaddr_un.sun_path` is 104 bytes on macOS and the Application Support
path does not comfortably fit. Measured and explained in
[`decisions/0016-daemon-protocol.md`](decisions/0016-daemon-protocol.md).

See [`decisions/0005-persistence.md`](decisions/0005-persistence.md).

---

## Session durability

Sessions survive the app. That is the point of the daemon, and it is now a product
guarantee rather than a limitation to apologise for.

What survives what:

| Event | Terminals |
| --- | --- |
| Close the window, quit the app | **Survive.** |
| App crash | **Survive.** |
| App update | **Survive** until the user chooses to restart the daemon. |
| Daemon crash | Die. launchd restarts it; sessions return `.idle` from the database. |
| Logout, reboot | Die. Sessions return `.idle`. |

Surviving a reboot would mean re-establishing processes rather than keeping them,
which is a different and much larger promise. It is explicitly not made.

---

## What is deliberately absent

- **No dependency-injection container.** Constructor injection from
  `AppEnvironment.live()` in the app and `DaemonEnvironment.live()` in the daemon.
- **No coordinator/router layer.** SwiftUI scenes and `NavigationSplitView` suffice.
- **No view models per view.** `@Observable` mirrors hold state; views read them.
- **No job scheduler.** Automation is a command bound to a lifecycle event, run in
  a terminal.
- **No forge API client.** We shell out to the user's `gh`/`glab`.
- **No network listener in v1.** The protocol is transport-agnostic; only the Unix
  socket is built. See [`decisions/0016-daemon-protocol.md`](decisions/0016-daemon-protocol.md).
- **No daemon self-update, and no PTY hand-off across exec.** Upgrades are a user
  decision with a visible cost.
- **No plugin API.** See [`product.md`](product.md) § Non-goals.
