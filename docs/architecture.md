# Architecture

How Janela is put together, and why the seams are where they are.

Read [`product.md`](product.md) first — the structure below exists to serve that
thesis, and several choices only make sense in its light.

---

## Shape of the system

**Two processes.** A daemon owns everything durable; the app is one of its clients.

```text
┌────────────────────────────────────┐     ┌──────────────────────────────────────┐
│ Janela.app                         │     │ janelad  (one per user, launchd)     │
│                                    │     │  one compiled binary                 │
│  src-tauri/ ── Rust shell          │     │                                      │
│    window · native menus ·         │     │  @janela/daemon  listener, frames    │
│    notifications · file dialogs ·  │     │  @janela/session the brain           │
│    sidecar · THE SOCKET            │     │  @janela/terminal PTY + emulator     │
│         ▲                          │     │  git │ pty │ db │ forge              │
│         │ Tauri IPC (raw bytes)    │     │                                      │
│         ▼                          │     │                                      │
│  src/ ───── WebView                │     │                                      │
│    @janela/ui        views         │     │                                      │
│    @janela/terminal-ui  renderer   │     │                                      │
│    @janela/client    mirror        │     │                                      │
└───────────────┬────────────────────┘     └──────┬──────────────┬────────────────┘
                │                                 │              │
                │   unix socket, framed           │ fork + PTY   │ subprocess
                └─────────────────────────────────┤              ▼
                                                  ▼         git / gh / glab
                                           shell / agents
```

Everything both sides share — `@janela/core` (domain types) and `@janela/protocol`
(wire format) — is pure, plain, and links into both.

The extra hop on the left is the one structural cost of a WebView client: **a WebView
cannot open a Unix socket**, so the Rust shell opens it and relays frames. That is
the whole of what the shell does with the protocol — it moves bytes and never reads
them.

The daemon/client split itself comes down to this: sessions have to outlive the
window, and a CLI and a remote client both need something that is not a window to
talk to.

### What the split buys, concretely

- **Closing the app costs nothing.** Agents keep working, dev servers keep serving.
- **The app cannot spawn a process.** `@janela/ui` does not link git, PTY, the
  database or the terminal layer. The capability is not merely discouraged; it is
  absent.
- **Floods stop at the daemon.** See [Terminal data flow](#terminal-data-flow).
- **The CLI and a phone are clients**, not features. Same protocol, same messages.

### What it costs

- A repaint encoder we own, which is the hard part.
- Version skew between app and daemon, with a user-facing story.
- Two signed binaries in one bundle.
- State that can be *stale* as well as wrong, which no type system can check.
- One more boundary on the keystroke path, budgeted in
  [`performance.md`](performance.md).

---

## Packages

The graph lives in `scripts/layers.ts` **as data**, and `bun run check:layers`
enforces it. Dependencies point downward only, and an illegal import fails a command
rather than depending on a reviewer noticing — which it did not, for free, once the
compiler stopped doing it.

```text
                @janela/support     logging, errors, timing, bounded buffers
                       ↓            (+ /process — subprocess, daemon-only)
                @janela/core        domain types. Pure. No I/O.
                       ↓
                @janela/protocol    frames, messages, handshake, transport seam
                  ↙          ↘
    ==== daemon ====           ==== client ====
    git   pty   db   forge     client        connection, mirror, attention policy
         ↓                        ↓
    terminal                   design        tokens and reusable controls
         ↓                        ↓
    session                    terminal-ui   the renderer surface
         ↓                        ↓
    daemon                     ui            views
         ↓                        ↓
    apps/daemon → janelad      apps/desktop  Tauri shell + composition root
```

The two halves meet **only** at `@janela/core` and `@janela/protocol`. That is what
makes a CLI possible without a refactor, and why the UI cannot spawn a process even
by accident.

### Shared

| Package | Owns | Must not |
| --- | --- | --- |
| `@janela/support` | `Log`, timing marks, `UserFacingError`, bounded buffers | Know anything about the domain. Its `/process` subpath is daemon-only, so the rest stays linkable into a WebView |
| `@janela/core` | `Project`, `Session`, `TerminalDescriptor`, `SessionLayout`, `AutomationCommand`, `LaunchProfile` | Perform I/O, or hold anything that does not survive JSON |
| `@janela/protocol` | Frames, messages, handshake, transport seam | Know how anything is *implemented* on either side |

### Daemon side

| Package | Owns | Must not |
| --- | --- | --- |
| `@janela/git` | Running `git`; worktree create/list/remove/safety; `.worktreeinclude` | Leak a command string above its API, or import `@janela/forge` |
| `@janela/pty` | `PseudoTerminal`, the native reader, sizing, signals | Know about sessions or clients |
| `@janela/db` | Prisma store, schema, migrations, repositories | Contain business rules, or let a Prisma type escape |
| `@janela/forge` | Running `gh` / `glab` | Own credentials, block a request, or import `@janela/git` |
| `@janela/terminal` | `LiveTerminal`, authoritative grid, damage tracking, repaint encoding | Be imported *through* — no emulator type leaks upward |
| `@janela/session` | Project and session lifecycle, automation, `ShellEnvironment`, removal planning | Import a view layer, or know a socket exists |
| `@janela/daemon` | Listener, connections, subscriptions, peer-credential checks, the frame loop | Contain product logic that belongs in `@janela/session` |
| `apps/daemon` → `janelad` | Socket activation, signals, idle exit | Contain anything testable |

### Client side

| Package | Owns | Must not |
| --- | --- | --- |
| `@janela/client` | Connection, reconnect, the mirrored state, attention policy | Import anything daemon-side, or anything platform-specific |
| `@janela/design` | Tokens, semantic colours, shared controls | Know what a session is |
| `@janela/terminal-ui` | `TerminalRendering`, the surface that draws | Own a PTY or a child process |
| `@janela/ui` | Views and presentation state | Reach past `@janela/client` |
| `apps/desktop` | The Tauri shell, the object graph, menus, notifications, the socket bridge | Contain logic worth testing |

*Planned* means designed and documented but not yet implemented.

### Four rules that catch most mistakes

1. **No client package may import a daemon package, or vice versa.** They meet only
   at `@janela/core` and `@janela/protocol`.
2. **Only `@janela/terminal` (daemon, headless) and `@janela/terminal-ui` (client,
   the view) may name a terminal library.** Two seams, one rule — see
   [Seam 2](#2-terminalemulating--the-vt-parser-and-the-grid-daemon) for what changed
   about the *library* half of that.
3. **Nothing in `@janela/session` or below may import a view layer.** The daemon
   detects attention, the client decides, the app delivers.
4. **`@janela/git` and `@janela/forge` are peers and must never import each other.**
   Shared subprocess plumbing lives in `@janela/support/process`.

Each is checked, along with a table of **gated modules** — `bun:ffi` only in
`@janela/pty`, `bun:sqlite` and `@prisma/client` only in `@janela/db`,
`node:child_process` only in `@janela/support`, `@tauri-apps/*` only in the desktop
app, and `@base-ui/react` plus `cn` only in `@janela/design`.

The last pair is the newest, and it is rule 2 applied to a second library family:
`@janela/design` names the primitive library, and everything above it composes what
that package exports. A view that reaches for `@base-ui/react` directly is a view
that has to be rewritten when the library does — and a second copy of `cn` is a
second set of rules for resolving conflicting Tailwind utilities, with nothing to
say which control used which.

---

## The seams that matter

Five boundaries carry the design risk. Each is deliberately narrow, and all five
survived a total change of language — which is the best evidence available that they
were real boundaries rather than artefacts of the old stack.

### 1. `MessageTransport` — how bytes reach the daemon

An interface over "deliver these frames, give me those frames". Two implementations
today, both local: the daemon's socket listener, and the app's bridge through the
Tauri shell. A WebSocket implementation later makes a browser client a transport
rather than a rewrite. Nothing above it knows which.

### 2. `TerminalEmulating` — the VT parser and the grid (daemon)

Feed bytes, resize, ask for damage since a revision, serialise the grid for a
newly-attached client, snapshot text. Backed by `@xterm/headless`, and nothing above
`@janela/terminal` may name it.

One property changed and it is worth stating plainly: the daemon and the client no
longer run the *same* library, only the same family. The protocol ships escape
sequences, so they need agree on VT semantics rather than on an internal format —
but "they cannot disagree because they are the same code" has become "they should not
disagree", which is a real cost and not a theoretical one.

### 3. `TerminalRendering` — the surface (client)

Feed bytes, resize, focus, selection. Backed by `@xterm/xterm`, in
`@janela/terminal-ui`, and equally sealed.

### 4. `GitRunning` — the git boundary

Everything git goes through a process runner taking an argument array. No shell, so
no quoting bug class. Also owns `.worktreeinclude` resolution, because the honest
implementation of "which ignored files match these patterns" is `git ls-files`, not a
matcher we wrote.

### 5. `AttentionDelivering` — notification policy vs. delivery

The daemon detects and emits a fact. `@janela/client` applies policy, because only a
client knows what is focused. `apps/desktop` delivers, because notifications are an
app-level capability.

---

## Terminal data flow

The single most important path in the system.

```text
child process
    │ raw bytes, up to 100 MB/s
    ▼
PTY reader thread          Rust, blocking reads, high/low water marks
    │                      past the high mark it stops reading: the kernel buffer
    │                      fills and the child blocks in write(2). Nothing is dropped.
    ▼
drain, once per frame      ONE large call. Chunk size is not a detail — measured,
    │                      8 KB writes sustain ~6 MB/s into the emulator and 1 MB
    │                      writes sustain ~140 MB/s.
    ▼
headless emulator          authoritative grid + bounded scrollback
    │                      damage tracked per cell
    │ once per frame, per attached client:
    │ encode the shortest escape sequence that repaints what changed
    ▼
socket frame (raw kind)    bounded by frame rate, not throughput
    ▼
Tauri IPC (raw bytes)      never base64, never wrapped in JSON
    ▼
TerminalRendering          an ordinary terminal view, fed bytes
    ▼
pixels
```

Why encode escape sequences rather than ship a grid: every client already knows how
to consume them. The app's renderer, a browser's, a real terminal for the CLI. We
invent no rendering format and no client needs to learn one — and it is what let the
*engine* change entirely without the protocol noticing.

Why this is faster than an in-process design: a `yes` flood produces 100 MB/s that a
UI would have to survive. Instead it lands in a process with no UI, and roughly 60
screens per second of changed cells reach the app.

**Attach** is the same encoder run against the whole grid instead of the damage set,
which is why reconnecting after an hour costs one screen and is correct for
full-screen TUIs rather than lucky.

---

## Key flows

### Creating a session

One public entry point, `SessionService.createSession`, reached by clients through
one message. Worktree creation is one case of it.

```text
app  →  ClientMessage.createSession({ kind: "newWorktree", … })
          │  socket
          ▼
        SessionService (@janela/session, in the daemon)
          ├─ persist the session with backing: worktree, and announce it
          ├─ createWorktree()          → git worktree add -b …
          ├─ worktreeInclude.copy()    → git ls-files -o -i --exclude-from
          ├─ automation.run(worktreeCreated)  → a terminal, visible
          ├─ automation.run(sessionStart)     → a terminal, visible
          └─ create the user's TerminalDescriptor (not started)
                  │
                  ▼  DaemonMessage.state(…) to every subscriber
        every attached client updates, including ones that did not ask
```

Nothing blocks: progress is published as state updates, and the requesting client may
disconnect mid-flight without affecting the outcome. Persisting first is deliberate —
the session is visible and selectable before a `worktree add` that may take seconds —
and what pays for it is the rollback: a `createWorktree` failure removes the record
again, announces the shortened list, and rethrows git's own error. Everything after
that is ordered because scripts depend on it: a `worktreeCreated` command that ran
before the copy would find no `.env`.

Four decisions live in the dialog that produces that message, and are worth
finding here rather than in a diff:

- **Two comboboxes, not five commands.** The branch and the worktree are each a
  field that filters a list *and* accepts a name the list does not have
  (`@janela/design`'s `Combobox`, item 14 of `packages/design/src/index.ts`).
  That one control is what collapses the creation cases into one form: a branch
  picked is an existing branch and a branch typed is created with its worktree;
  a worktree picked is `adoptWorktree` and a worktree named is `newWorktree`.
  The start point is the same field again — a branch from the list, or a tag or
  a commit typed.
- **One sheet, including for a new branch.** "New Session" is the only way a
  session is made. There is no second command, sheet or accelerator for a new
  branch, because a new branch was never a different kind of thing
  (`docs/product.md` § The thesis).
- **The radio is down to the one genuine fork**, the project's own directory or
  a directory of its own, and only the first can be refused: git checks a
  branch out in one place at a time. A *second worktree* of a held branch is
  possible under `git worktree add --force`, so the worktree field takes a name
  for one, says that a commit in one moves the other, and sets `shareBranch` —
  the only thing in the system that asks for `--force`. The daemon never infers
  it: a request that did not ask reaches git unforced and gets git's refusal,
  which is also what a v6 daemon does with the field it does not know
  (`packages/protocol/src/handshake.ts`).
- **The worktree's name is the session's, and names its directory.** The leaf
  only; the root stays the daemon's, from `ProjectSettings.worktreeRoot`. It
  defaults to the branch, and it is what keeps two worktrees of one branch off
  the same path without a `-2` nobody asked for.

### Starting a terminal

```text
LiveTerminal.start()                      in the daemon
   ├─ resolve command      (LaunchProfile, or the login shell)
   ├─ resolve environment  (ShellEnvironment + JANELA_* vars)
   ├─ spawnPseudoTerminal()  → openpty + fork + login_tty + execve
   ├─ reader thread          → blocking reads, water marks
   └─ emulator.feed(bytes)   → grid updated, damage recorded
```

`fork` rather than `posix_spawn` is not a preference: only the child, after
`setsid()`, can claim a controlling terminal, and without one Ctrl-C delivers no
signal and every TUI misbehaves.

### Attaching and reattaching

```text
client: attach(terminalID, viewport: 120×40)
daemon: resize the PTY to min(all attached viewports)
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

**The daemon is single-threaded, and everything genuinely concurrent is in Rust.**

- **No shared mutable state to race over.** The session registry and the connection
  table are ordinary objects on one event loop. This is a weaker guarantee than a
  compiler checking isolation, and it is stated plainly rather than claimed as an
  equivalent.
- **The hazard that replaces data races is blocking the event loop.** Every blocking
  read lives on a thread inside the PTY's native library and reaches JavaScript as a
  buffer to drain. A blocking call in daemon code stalls *every* terminal at once.
- **The read path never allocates per byte**, and drains once per frame into a
  reusable buffer.
- **Per-client back-pressure.** A client that stops reading slows only its own
  stream. Coalesced repaints may drop their oldest entry; control frames and terminal
  input may not, ever.
- **The client has one thread**, which is what a WebView gives us. The ownership rule
  that used to be enforced by main-actor isolation — the mirror is written only from
  daemon updates — survives as a rule.

Measured: 133 MB/s sustained under a `yes` flood, ~4 MB of memory growth with the
consumer stalled, and 1.7 ms worst-case event-loop lag during the flood with a second
terminal staying interactive throughout.

---

## Persistence

SQLite via Prisma at
`~/Library/Application Support/sh.janela.Janela/janela.sqlite`, opened by **the
daemon and nothing else**. Clients read state over the protocol; a client package
that imports `@janela/db` is a layering bug, and the gate refuses it.

The Prisma client is generated, `bun:sqlite` is the driver behind an adapter we own,
and the whole thing survives `bun build --compile` — which is not a detail, it is the
constraint that decided the driver.

The socket lives at `~/.janela/run/janelad.sock` instead, for an unglamorous reason:
`sockaddr_un.sun_path` is 104 bytes on macOS and the Application Support path does
not comfortably fit. Measured, not assumed.

---

## Session durability

Sessions survive the app. That is the point of the daemon, and it is a product
guarantee rather than a limitation to apologise for.

| Event | Terminals |
| --- | --- |
| Close the window, quit the app | **Survive.** |
| App crash | **Survive.** |
| App update | **Survive** until the user chooses to restart the daemon. |
| Daemon crash | Die. launchd restarts it; sessions return idle from the database. |
| Logout, reboot | Die. Sessions return idle. |

Surviving a reboot would mean re-establishing processes rather than keeping them,
which is a different and much larger promise. It is explicitly not made.

---

## The window's chrome

The title bar is an **overlay**: `titleBarStyle: "Overlay"` with `hiddenTitle`, so
the WebView fills the window and macOS draws the traffic lights on top of the
sidebar's first row. That row used to carry the app's mark and the word "Janela",
16px below a title bar already saying it; the buttons say it now, and the rest of
the row is the band that drags the window.

Two consequences worth stating:

- **The position is a contract between two files that cannot import each other.**
  `TRAFFIC_LIGHT_POSITION` in `@janela/ui` is measured against that row — its
  height comes from the size ladder — and `tauri.conf.json` has to carry the same
  numbers. `apps/desktop/src/window-controls.test.ts` holds it to them, because
  the failure mode is buttons sitting on top of a control rather than anything a
  compiler or a person reviewing a diff would notice.
- **Whether the buttons are there is a port, not an assumption.**
  `WindowControls` answers one boolean, and only the shell can: macOS takes the
  buttons away in fullscreen, and `titleBarStyle` is a macOS-only key, so any
  other platform draws its controls in a title bar of its own. In both cases the
  answer is `false`, nothing is reserved, and the row is simply empty at its
  leading end — the mark does not come back as a fallback, because a window with
  its own title bar does not need the sidebar to repeat the app's name.

---

## What is deliberately absent

- **No dependency-injection container.** Constructor injection from
  `liveEnvironment()` in the app and `daemonEnvironment()` in the daemon.
- **No router layer.** The app is a sidebar and a detail pane.
- **No view models per view.** Observable stores hold state; views read them.
- **No job scheduler.** Automation is a command bound to a lifecycle event, run in a
  terminal.
- **No forge API client.** We shell out to the user's `gh`/`glab`.
- **No network listener in v1.** The protocol is transport-agnostic; only the local
  transports are built.
- **No second FFI surface.** `@janela/pty` owns the only one, and a future need —
  `launch_activate_socket` is the known candidate — should go through it rather than
  opening another.
- **No daemon self-update, and no PTY hand-off across exec.** Upgrades are a user
  decision with a visible cost.
- **No Linux or Windows build.** The architecture does not foreclose one; we do not
  test, ship or support it.
- **No plugin API.** See [`product.md`](product.md) § Non-goals.
