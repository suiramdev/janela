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

### The gateway

A browser cannot open a Unix socket either, and unlike the WebView it has no Rust
shell beside it. `apps/gateway` (`janela-gateway`, layer 7, daemon side) is the
browser's shell: a Bun process on the same Mac that serves the built browser
client (`apps/web/dist`) and, for every WebSocket a page opens at `/ws`, opens one
connection to `~/.janela/run/janelad.sock` and relays bytes in both directions
without reading them. It is the exact shape of `bridge.rs` with a network on the
outside instead of Tauri IPC.

Three consequences fall out of "one WebSocket = one daemon connection":

- **The daemon is untouched.** It still has no network listener; the peer it sees
  is the gateway, running as the user, so the peer-uid check and the 0600 socket
  hold unchanged. A gateway crash kills no terminal.
- **Idle exit keeps working.** The gateway holds no connection of its own, so a
  Mac with no page open looks to `janelad` exactly as it did before.
- **Back-pressure composes.** A slow page fills its WebSocket buffer; the gateway
  pauses that one Unix socket; the daemon's per-client output queue then drops
  oldest and re-arms a full repaint, as it does for a slow app. No frame is
  parsed and no new buffer is introduced beyond the bounds in
  [`packages/gateway.md`](packages/gateway.md).

Who may connect is decided at the network, not in the protocol — the decision of
2026-09-16. The gateway binds `127.0.0.1` only, refuses a WebSocket upgrade whose
`Origin` is not the page it served (so a cross-site page cannot drive the user's
terminals), and is published to the user's other devices with
`tailscale serve --bg 7411`, which terminates TLS on the tailnet and vouches for
the remote identity. The accepted cost: the loopback interface is shared by every
account on the Mac, so a second local user can reach the gateway while it runs —
the Unix socket alone refuses them. `Hello.credential` stays unused; if that cost
becomes unacceptable, a gateway-minted bearer token on the upgrade is the next
step, and it changes nothing above the transport.

A phone client is another WebSocket peer of the gateway. It speaks the same frames,
gets the same repaints, and needs nothing server-side that does not already exist.

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
    apps/gateway → the         apps/web      the browser client: same views,
      browser's shell                        a WebSocket transport, no macOS ports
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
| `apps/daemon` → `janelad` | Socket bind, signals, idle exit | Contain anything testable |
| `apps/gateway` → `janela-gateway` | Serving `apps/web/dist`; one WebSocket ↔ one Unix-socket connection, bytes relayed unread; the origin check; `launchctl kickstart` when the socket is gone | Read a frame, hold a daemon connection of its own, or bind anything but loopback |

### Client side

| Package | Owns | Must not |
| --- | --- | --- |
| `@janela/client` | Connection, reconnect, the mirrored state, attention policy | Import anything daemon-side, or anything platform-specific |
| `@janela/design` | Tokens, semantic colours, shared controls | Know what a session is |
| `@janela/terminal-ui` | `TerminalRendering`, the surface that draws | Own a PTY or a child process |
| `@janela/ui` | Views and presentation state, internally Feature-Sliced (below) | Reach past `@janela/client` |
| `apps/desktop` | The Tauri shell, the object graph, the port adapters, menus, notifications, the socket bridge | Contain logic worth testing |
| `apps/web` | The browser client: the object graph over a WebSocket transport, the in-app folder picker host, the console log sink | Name a port only the Mac can answer — `ClientEnvironment.local` is `undefined` here |

*Planned* means designed and documented but not yet implemented.

### Inside `@janela/ui`: Feature-Sliced Design

Sixty view files in one flat directory had stopped saying where anything belonged,
so the *inside* of `@janela/ui` has a structure of its own —
[Feature-Sliced Design](https://feature-sliced.design), with `packages/ui/src` as
its root. The package graph above is unchanged by it: from FSD's point of view
`@janela/core`, `@janela/protocol`, `@janela/client`, `@janela/design` and
`@janela/terminal-ui` are third-party libraries, and `bun run check:layers` still
owns every edge *between* packages.

```text
packages/ui/src/
  index.ts              the *package* public API: what apps/desktop imports, and nothing more
  pages/
    main-window/        the window — frame, sidebar, panes, tab strip, sheets, banner, confirmations
      index.ts  ui/  model/
    settings/           the settings screen — tabs, panes, the draft, and what a save writes
      index.ts  ui/  model/
  shared/
    model/              the window's stores and the ports the app implements   (index.ts)
    config/             the command catalogue, the profile-icon catalogue      (index.ts)
    ui/                 window chrome, context menus, find surface, project icon (index.ts)
    lib/                fuzzy-match/, test-fakes/                (an index.ts per folder)
```

Segments are the standard five, and only four are used: `ui`, `model`, `config`,
`lib`. Imports point **downward, `pages → shared`**, and cross a slice or a shared
segment only through its `index.ts`. `bun run check:fsd` enforces that — Steiger
with `fsd.configs.recommended`, run from `packages/ui` so it finds
`packages/ui/steiger.config.ts` — and it runs inside `bun run lint` beside
`check:layers`.

**There is no `features/` and no `entities/` layer**, and that is a decision
rather than an omission. The domain models already live in `@janela/core`, which
FSD sees as an external library, so what the views add on top is derived view
(`sessionStatus`, `sidebarRows`) and form drafts — and every one of those has all
its consumers inside a single page. FSD extracts only once a second consumer
exists, and Steiger's `insignificant-slice` reports a feature used by one page as
a slice to merge back, so the graph has not earned either layer.

Two rules decide where a file goes, and they are not the same rule:

- **Pages first, by count.** A feature or an entity is earned by a *second*
  consumer. Duplication between two pages is cheaper than a boundary drawn on one
  example.
- **Shared, by content.** `shared/` is decided by what a module *is*, not by how
  many callers it has: no business logic, no knowledge of any screen.
  `fuzzy-match`, `find-surface` and `context-menu-region` are shared with one
  consuming page each, because they name no domain type and would read the same in
  a browser client. The settings panes' labelled fields are not, because
  `ProfileSelect` takes a `LaunchProfile` and the rest encodes how that screen's
  forms read.

`apps/desktop/src` is the FSD **`app` layer**: the entry point, the object graph
(`liveEnvironment`), and `adapters/` — the Tauri implementations of every port
`shared/model/client-environment.tsx` declares (clipboard, native shell, window
controls, command source, settings storage, transport, attention delivery).

It is a *thinner* app layer than FSD assumes, and this is the one place the
methodology was bent on purpose. FSD puts routing and the app-wide layout in
`app`; here the window frame — the providers, the root right-click region, the
connection banner, the sheet host, the confirmation host — stays in
`pages/main-window`, because moving it would move some 550 lines of views and
their tests into a package that is supposed to contain nothing worth testing. So
`pages/main-window` is both a page and the application shell, and the two pages
are composed by the app rather than by each other: `MainWindow` takes
`MainWindowProps.renderSettings`, and `main.tsx` fills that slot with
`<SettingsScreen route={route} />`. Neither page names the other, which is what
FSD forbids and Steiger reports.

One seam inside `shared/model` is worth knowing before editing it. `ViewState`
holds the settings screen's **uncommitted draft**, so that navigating away cannot
throw away what the user typed — which puts the draft's *shape* below both
screens, in `shared/model/settings-draft.ts`, along with the profile form shape it
names. The *rules* over that value — what a save writes, what refuses it, what an
unnamed profile is called — live in `pages/settings/model`, because a rule the
product enforces on the user's data is not infrastructure, and Shared may not hold
one.

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

## Effect at the seams

Effect v4 is a tool we reach for at a boundary, not the runtime the application
is written in. A file that uses it should be a file where something crosses into
the program from outside, or where a failure set is closed enough to be worth
naming.

In scope:

- **`Schema` at every untrusted boundary** — socket control frames, persisted
  JSON, configuration, IPC payloads. It replaces `typeof`, `in` and `as`, which
  are guesses about a value's shape rather than evidence about it. Parse at the
  edge, then work with the domain value.
- **`Schema.TaggedError` / `Data.TaggedError` for closed failure sets**, so a
  caller can branch with `Match.tag`, `Effect.catchTag` or `Predicate.isTagged`
  and the compiler can tell it when a case is missing. Never read `_tag`.
  `FrameError` in `@janela/protocol` is the reference shape: one error class
  carrying a tagged `reason`.
- **`Match` for a discriminant**, in place of `switch` and chained literal
  ternaries. `Match.exhaustive` is the point.
- **`Effect.try` / `Effect.tryPromise` / `Effect.acquireRelease` / `Scope` for
  I/O lifetimes** in the daemon's subprocess, git, forge, database and session
  layers, where a thrown value would otherwise lose its type and a resource
  would otherwise be released by hand.

Out of scope, deliberately:

- **The terminal byte path.** The PTY reader, the emulator feed, the repaint
  encoder and the raw `Input`/`Output` frames run per keystroke and per repaint.
  They stay plain, allocation-free code against the budgets in
  [`performance.md`](performance.md).
- **React render paths.** A render is not a boundary, and an Effect in one is a
  scheduler fighting a scheduler.
- **Anything under a performance budget.** If `performance.md` names it, it is
  not a place to add indirection.

One hard rule on top: no Effect construct may introduce an unbounded buffer.
A `Queue`, a `PubSub` or a `Stream` with no capacity is the same defect as an
unbounded array, and AGENTS.md non-negotiable 9 applies to it identically.

Domain values in `@janela/core` stay plain and JSON-shaped. A `Schema.Struct`
describing one is fine as long as the derived type is still a plain readonly
object and encoding is the identity; a domain type is never an Effect class with
methods on it.

---

## The seams that matter

Five boundaries carry the design risk. Each is deliberately narrow, and all five
survived a total change of language — which is the best evidence available that they
were real boundaries rather than artefacts of the old stack.

### 1. `MessageTransport` — how bytes reach the daemon

An interface over "deliver these frames, give me those frames". Three
implementations today: the daemon's socket listener, the app's bridge through the
Tauri shell (`apps/desktop/src/adapters/transport.ts`), and the browser client's
WebSocket to the gateway (`apps/web/src/adapters/transport.ts`). Nothing above it
knows which — `@janela/client` runs the same reconnect, handshake and mirror over
all three.

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
client knows what is focused. `apps/desktop` delivers
(`apps/desktop/src/adapters/notification-delivery.ts`), because notifications are an
app-level capability.

The rest of what only an app can do — the clipboard, the directory picker, the
window controls, the menu bar, settings storage — is the same shape and is not a
sixth seam: the ports are declared in `packages/ui/src/shared/model/client-environment.tsx`,
beside the views that consume them. The ones a standards-compliant browser can
implement on its own — the clipboard, `localStorage` settings, keyboard chords —
are implemented once in `packages/ui/src/shared/lib/web-platform/` and used by
both apps; the ones only the Mac can answer — Finder, Terminal.app, `launchctl`
— are grouped as `ClientEnvironment.local`, which the desktop app implements in
`apps/desktop/src/adapters/` and the browser client leaves `undefined`. A view
that needs `local` does not render its affordance without it, which is how
"Reveal in Finder" and the background-service controls disappear in a browser
rather than fail there.

The directory picker is the port in between, and the reason it is a port rather
than a member of `local`: the Mac answers it with `NSOpenPanel`, and a browser
answers it with the daemon, which reads one folder at a time on request
(protocol v8's `listDirectory`) for a Finder-style column view drawn by the
client. The daemon gains a read of the user's filesystem by name only, one
folder per request, bounded and with dotfiles left out
([`packages/session.md`](packages/session.md) § directory-browser.ts) — and it
is the same daemon the Mac client already trusts to *run things* in those
folders. The upshot is that Open Folder… and Add Project… are commands of every
client, not of the Mac.

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
  numbers. `apps/desktop/src/adapters/window-controls.test.ts` holds it to them,
  because the failure mode is buttons sitting on top of a control rather than
  anything a compiler or a person reviewing a diff would notice.
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
- **No network listener in the daemon.** The protocol is transport-agnostic; the
  daemon binds only its Unix socket, and the network face is the gateway (above).
- **No second FFI surface.** `@janela/pty` owns the only one, and a future need —
  `launch_activate_socket` is the known candidate — should go through it rather than
  opening another.
- **No daemon self-update, and no PTY hand-off across exec.** Upgrades are a user
  decision with a visible cost.
- **No Linux or Windows build.** The architecture does not foreclose one; we do not
  test, ship or support it.
- **No plugin API.** See [`product.md`](product.md) § Non-goals.
