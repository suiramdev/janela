# 0015. A daemon owns sessions; the app is a client

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** the single-process premise in [`../architecture.md`](../architecture.md)
  § Shape of the system, and its § Session durability section.

## Context

Until now Janela was one process. Closing the window killed every child: the agent
mid-task, the dev server, the build. The previous architecture document was honest
about this — it called a PTY-owning daemon "a plausible v2" and asked that it
arrive as an ADR rather than as an incremental leak. This is that ADR.

Three requirements force it, and only the first is about durability.

**1. Sessions must outlive the UI.** An agent running for twenty minutes should not
care that the user quit the app, and a `pnpm dev` started by project automation
should still be serving when they come back. Today the app is a coffin for its own
child processes.

**2. A CLI needs the same state.** `janela` as a tool an agent can call — "list my
sessions", "what is on screen in the build terminal", "start a session on this
branch" — requires something to ask. A CLI that reaches into a running GUI app is
not a thing; a CLI that talks to a service is ordinary.

**3. Remote clients need a server.** Connecting from a phone means something on the
Mac is listening and holds the state. That thing cannot be the window.

All three are the same shape: **the state and the processes must live somewhere
that is not a window.**

The cost is real and worth stating before the decision rather than after. A daemon
introduces IPC on the hot path, a second executable to sign and ship, version skew
between client and daemon, a background process users must be able to see and
stop, and a new class of bug where the UI and the truth disagree.

### The question that decides the shape

Given a daemon that owns the PTY, *where does terminal state live?*

**Raw byte relay.** The daemon owns the process and a ring buffer of recent output,
and relays bytes. The emulator stays in the client. Small daemon, and the existing
`TerminalEmulating` seam is untouched. But a client that reattaches after an hour
must replay the buffer, which reconstructs a full-screen TUI only by luck: alt-screen
switches, partial escape sequences and cleared scrollback all make byte replay a
guess. And every byte of a `yes` flood crosses the socket.

**Authoritative grid.** The daemon runs a headless emulator and holds the screen and
scrollback as the source of truth. Attaching is "send me the screen", which is
correct by construction. This is tmux's model, and tmux is the existence proof that
it works for exactly our workload.

## Decision

**A user-level daemon, `janelad`, owns everything durable. The app is one of its
clients.**

```text
janelad  (one per user, launchd-managed)
  ├── PTYs and child processes            ← survive every client disconnecting
  ├── a headless emulator per terminal    ← authoritative screen + scrollback
  ├── the SQLite database                 ← single writer, no file sharing
  ├── project and session lifecycle, git, forge, automation
  └── a Unix domain socket
        ├── Janela.app        (renders, delivers notifications)
        ├── janela CLI        (future — agent skills)
        └── remote clients    (future — see 0016)
```

### Terminal data flow

The daemon holds the authoritative grid, and **emits minimal repaint sequences**
rather than relaying raw output:

```text
child process
    │ raw bytes, up to 100 MB/s
    ▼
headless emulator in janelad          ← authoritative grid + bounded scrollback
    │ damage-tracked, coalesced once per frame,
    │ encoded as the shortest escape sequence that repaints what changed
    ▼
socket                                 ← bounded by frame rate, not by throughput
    ▼
client's renderer (SwiftTerm view, or xterm.js, or a phone)
```

Three properties fall out of this, and together they are why the grid wins:

- **Attach is a screen, not a history.** Reattaching sends one repaint synthesised
  from the grid. Correct after a second or after a day, for full-screen TUIs as
  much as for shells.
- **A flood never reaches the client.** `yes` at 100 MB/s becomes ~60 screens per
  second of changed cells. The old in-process design had to survive that flood in
  the UI; now the daemon absorbs it. This is a *better* performance story than the
  architecture it replaces.
- **Clients stay byte-fed.** Because the repaint is escape sequences, the client
  renderer is an ordinary terminal view. SwiftTerm on macOS and xterm.js on the web
  both work with no adaptation, and no client needs to understand our grid format.

The daemon additionally exposes the grid as **text**, which is what makes a CLI
useful to an agent: "what is on screen in the build terminal" is a protocol
request, not a screen-scrape.

### What moves, and what does not

| Concern | Before | Now |
| --- | --- | --- |
| PTY, child processes | app | **daemon** |
| VT parsing, screen, scrollback | app | **daemon** |
| Database | app | **daemon** (exclusive writer) |
| Projects, sessions, automation, git, forge | app | **daemon** |
| Attention *detection* | app | **daemon** |
| Attention *policy and delivery* | app | **app** — it alone knows focus and frontmost-ness |
| Rendering, selection, input | app | **app** |
| Window layout, sidebar state | app | **app** |

`JanelaSession` keeps its job as the UI-free brain; it simply now runs inside the
daemon. `JanelaUI` loses its dependencies on Git, PTY, Persistence and Terminal
entirely — the app *cannot* spawn a process any more, even by accident, because
nothing it links knows how.

### Rules

1. **The daemon is the source of truth. Clients render a mirror.** A client never
   computes state it could ask for, and never writes state it did not receive.
2. **Every client is equal.** The app has no privileged path. If the CLI cannot do
   it through the protocol, neither can the app — this is what keeps the protocol
   honest rather than shaped around one consumer.
3. **The daemon has no UI and no user interaction.** It cannot show a dialog or a
   notification. Anything needing a human goes to a connected client, and if none is
   connected it waits or is dropped, explicitly.
4. **Multiple clients may attach to one terminal**, and all see the same screen.
   This is required for handoff between the app and a phone, and it means the grid
   — not any client's window — determines the terminal's size (see 0016).
5. **The daemon starts on demand and stays.** It is socket-activated by launchd and
   outlives every client, but it exits when it owns no live terminals and no client
   is connected (see 0017).

## Consequences

**Good.** The product promise changes qualitatively. "Quit the app and lose your
work" was a real objection with no answer; now closing the window is free, and
`docs/product.md` § Laziness gains a companion property: leaving is free too.

**Good.** The CLI and remote server stop being architecture changes. They are new
clients of a protocol that already exists, which is the actual reason to do this
now rather than after v1.

**Good.** Flood isolation improves. The daemon absorbs high-throughput output and
the UI receives frame-rate-bounded updates, so a `cat` of a huge file cannot make
the interface stutter even in principle.

**Good.** Testability improves in an unexpected place: the entire session lifecycle
is now exercisable through a socket with no window server, which is a far better
test surface than an `@Observable` store in a UI process.

**Bad — and this is the big one.** We now own a **damage-tracking repaint encoder**:
the code that turns "these cells changed" into minimal, correct escape sequences.
This is the part of tmux that is genuinely hard, it is where subtle corruption
bugs live, and it is a permanent maintenance commitment. Mitigation: it sits behind
one protocol, it is byte-comparable against a reference emulator in tests, and a
correct-but-slow full repaint is always a valid fallback.

**Bad.** Latency on input. A keystroke now crosses two process boundaries before it
reaches the shell, and the echo crosses back. Over a Unix socket this is tens of
microseconds, far below a frame, but it is no longer zero and it is budgeted in
[`../performance.md`](../performance.md).

**Bad.** Version skew is now possible: the app updates while a daemon from the
previous version is still running and holding the user's terminals. This needs an
explicit protocol version handshake and an explicit user-facing story, both in
[0016](0016-daemon-protocol.md) and [0017](0017-daemon-lifecycle.md).

**Bad.** A background process that spawns other processes is a thing users are
right to be suspicious of. It must be visible, stoppable, and honest — hence
launchd registration the user can see in System Settings rather than a hidden
forked child.

**Bad.** Two executables to sign, notarize and keep in step, and a bundle layout
that is no longer "an app with one binary". See [0008](0008-sandboxing-and-distribution.md).

**Bad.** TCC prompts may now be attributed to `janelad` rather than to Janela,
because the daemon is its own responsible process. A permission dialog naming a
background daemon is a bad experience. Mitigation in [0017](0017-daemon-lifecycle.md):
file selection happens in the app through an open panel, and the daemon is handed
paths rather than discovering them.

## Alternatives considered

**Keep one process; accept that quitting kills sessions.** The status quo, and it
has a real virtue: no IPC, no skew, no second binary, no background process. It was
the right call while the product was "arrange terminals". It is the wrong call now
that the product is "run agents for twenty minutes at a time", and it forecloses
the CLI and the remote client entirely. Rejected on the requirements above.

**Tell users to run tmux inside Janela.** Free, works today, and genuinely what we
recommended. Rejected as the answer because it moves the durable state somewhere we
cannot see: one tmux process is one terminal to us, so the sidebar loses per-pane
status, which is the feature the app is judged on ([0006](0006-agent-activity-signals.md),
[0010](0010-terminal-layout.md)). It remains fully supported for people who want it.

**Raw byte relay with a replay buffer.** The smaller daemon, and it preserves the
existing emulator seam exactly. Rejected on reattach correctness — a byte replay
reconstructs a full-screen TUI by luck rather than by construction — and because
it puts flood traffic on the socket. Reconsider only if the repaint encoder proves
to be a worse problem than the one it solves.

**XPC instead of a socket.** The Apple-native answer, with launchd integration and
serialisation handled for us. Rejected because XPC is macOS-only and process-local
by design; a protocol that can also carry a remote client is a requirement, not a
nicety, and having two transports for the same protocol would double the surface.
See [0016](0016-daemon-protocol.md).

**A daemon per project, or per session.** Isolation between projects, and a crash
takes down less. Rejected: process-per-session is what the PTY already gives us,
and N daemons multiply the lifecycle, discovery and version-skew problems by N for
no gain the user can perceive.

**Sessions in a cloud service.** Removes the Mac from the picture for remote access
and is where a competitor would go. Rejected outright: it contradicts
[`../product.md`](../product.md) § Non-goals (no accounts, no sync, no telemetry) and
it would mean the user's source code leaves their machine. The daemon runs on the
user's Mac; a remote client connects *to their Mac*.

## Revisit when

- The repaint encoder proves harder to keep correct than the byte relay it
  replaced. The protocol can carry raw bytes as an alternative stream type without
  a redesign, so this is recoverable.
- Someone wants sessions to survive a *reboot*, which this does not provide and
  which is a much larger promise: it would mean re-establishing processes, not just
  outliving a window.
- A second daemon consumer appears that needs state the protocol does not carry —
  that is the signal the protocol was shaped around the app after all.
