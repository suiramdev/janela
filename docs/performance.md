# Performance

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> It describes the Swift stack — `make` targets, SwiftPM modules, SwiftTerm, GRDB,
> Xcode. The architecture, the domain model and the product thesis it serves are
> unchanged; the stack it names is gone.
>
> **Two budgets below are also out of date**, and this is the important part:
> cold launch is now **400 ms** (was 250) and warm launch **200 ms** (was 120),
> because the client renders in a WebView. *Every other budget on this page is
> unchanged*, including the terminal-throughput ones, which measured 133 MB/s off
> the PTY against a 100 MB/s budget. The before-and-after table and the reasoning
> for each row are in
> [`decisions/0023-macos-first-portable.md`](decisions/0023-macos-first-portable.md).
>
> Current: [`AGENTS.md`](../AGENTS.md) for commands and layering,
> [`architecture.md`](architecture.md) for the system,
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md) for where every module, type and seam went.
> Rewriting this file is a tracked follow-up.


Budgets, not aspirations. Each number below is something a change can be measured
against and a review can point at.

If you add a signpost, add its budget here. A signpost with no budget is
decoration.

---

## Why this document exists

"Fast" is not reviewable. "Cold launch under 250 ms, measured from process start
to first interactive frame" is. Janela competes with Electron-based tools on
exactly this axis — its reason to be native is that it is quicker and lighter — so
the numbers are a product requirement, not engineering vanity.

---

## Budgets

### Launch

Launch is now two things — the app becoming interactive, and the daemon being ready
— budgeted separately because they fail separately.

| Metric | Budget | Measured by |
| --- | --- | --- |
| Cold launch → interactive window | **250 ms** | `Signpost.launch`, Instruments App Launch |
| Warm launch → interactive window | **120 ms** | same |
| Connect + handshake, daemon already running | **10 ms** | `Signpost.connect` |
| Connect + handshake, daemon cold (socket-activated) | **200 ms** | `Signpost.connect`; includes fork/exec, database open, migrations |
| First full state (projects + sessions) after connect | **30 ms** | `Signpost.connect`, interval `state.initial` |
| Attach → first painted frame of an existing terminal | **50 ms** | `Signpost.attach` |
| Daemon: database open + first read | **15 ms** | `Signpost.daemonStart` |

Rules that protect this:

- **The window paints before the daemon answers.** The app draws its last known
  state, or an empty state, and fills in when the connection is up. A launch that
  waits on a socket has handed the daemon a veto over the launch budget — exactly
  the coupling the split was meant to remove.
- **Nothing blocks first paint.** Resolving the user's shell environment, refreshing
  git state, and probing for `gh` all happen daemon-side, after a client connects.
- **No terminal is started during launch or during attach.** Restored terminals come
  back `.idle`; the daemon does not spawn anything merely because someone attached.
- **Socket activation is on the cold path only.** The 200 ms figure is a fork/exec
  plus a database open plus migrations, paid once per daemon lifetime rather than
  once per launch.
- **Avoid adding dynamic library dependencies**, in both binaries. This is one of
  the reasons for [ADR 0005](decisions/0005-persistence.md): SwiftData would pull
  Core Data onto the launch path — now the *daemon's* launch path, which the first
  connecting window waits on.

### Interaction

| Metric | Budget |
| --- | --- |
| Session switch (both live) | **1 frame** — it is showing a view, not starting work |
| Tab switch within a session | **1 frame** |
| Expand/collapse a project | **1 frame**, and it reads nothing from disk |
| New terminal → first prompt | **150 ms** beyond the shell's own startup |
| Keystroke → glyph on screen | **1 frame**, including both socket crossings |
| Keystroke → daemon receives it | **< 1 ms** over a Unix socket |
| Split drag → reflowed panes | **1 frame**, with resizes coalesced |
| Sidebar refresh after a git change | **50 ms**, daemon-side, pushed not polled |
| Forge state appearing after a session opens | **best effort, never awaited** |

Two of these are new with the project/session model and are worth stating as rules
rather than numbers:

- **Collapsing or expanding a project does no work.** It is a boolean on a struct.
  If expanding a project ever needs to read git, load sessions, or refresh
  anything, the laziness rule has been broken somewhere upstream.
- **Nothing user-initiated waits on a subprocess.** Creating a worktree, copying
  `.worktreeinclude`, running automation and refreshing forge state all publish
  progress and let the user switch away. A modal spinner is a design bug, not a
  slow path.

The keystroke row is the one the daemon put at risk, and the one to defend. A
character now travels app → socket → PTY, and its echo comes back PTY → emulator →
socket → renderer. Over a Unix domain socket each crossing is tens of microseconds,
two orders of magnitude under a frame, so the budget is unchanged from the
single-process design. If it regresses, the cause will be a scheduling or coalescing
bug rather than the socket — and the fix is not to move the terminal back into the
app.

### Session creation

The one flow with real work in it. Budgets are wall-clock on a warm repository,
and each step reports progress rather than blocking the next interaction. All of it
runs in the daemon, and the requesting client may disconnect mid-flight without
changing any of these numbers.

| Step | Budget | Notes |
| --- | --- | --- |
| `git worktree add` | **300 ms** | Dominated by git; we add no measurable overhead |
| `.worktreeinclude` resolution | **50 ms** | One `git ls-files` invocation |
| `.worktreeinclude` copy, 500 MB `node_modules` | **200 ms** | `clonefile` on APFS is metadata-only; a non-APFS fallback is allowed to be slow |
| Session visible and selectable | **before automation starts** | The terminal must exist while `pnpm install` is still running |

The copy number is the one that justifies `clonefile` over a recursive copy — see
[ADR 0013](decisions/0013-worktreeinclude.md). If it ever approaches the seconds a
byte-for-byte copy would take, the clone path has silently stopped working.

### Terminal throughput

The hard case: a terminal producing output faster than we can render it — `yes`, a
verbose build, `cat` of a large file.

The daemon changed this problem's shape. The flood now lands in a process with no
UI, and what reaches the app is bounded by frame rate rather than by throughput.

| Metric | Budget | Where |
| --- | --- | --- |
| Sustained PTY throughput without stall | **≥ 100 MB/s** | daemon |
| Bytes on the socket during a flood | **≤ 2 MB/s** | boundary |
| Frame rate during a flood | **≥ 60 fps** | client |
| Memory growth during a sustained flood | **bounded** — see below | daemon |
| One flooding terminal's effect on others | **none measurable** | both |
| One flooding terminal's effect on its own split neighbours | **none measurable** | both |
| A stalled client's effect on the daemon or other clients | **none measurable** | daemon |

Two rows deserve explanation.

**Socket traffic during a flood.** 100 MB/s of `yes` output is at most 60 repaints
per second of an 80×24 grid; even repainting every cell every frame stays well under
2 MB/s. If a profile shows socket traffic tracking *throughput* rather than frame
rate, damage coalescing is broken — that is the single most valuable assertion in
the whole flood test.

**A stalled client.** A phone on a bad connection, or a suspended app, must not slow
the daemon or any other client. Each attached client has its own output queue with
its own bound; past that bound the daemon drops the queued *diffs* and marks the
client for a full repaint on recovery. Dropping a coalesced repaint is safe in a way
dropping PTY bytes never is — the grid remains authoritative, so the next frame is
correct regardless.

Panes in the same session still get their own `DispatchIO` channel and parse queue,
so a flooding pane cannot starve the pane beside it. Test it by splitting once and
running `yes` on the left.

The mechanism, specified in `ByteStream.swift` and
[ADR 0003](decisions/0003-concurrency-model.md):

- High-water mark **4 MB**, low-water **1 MB**. Past the high mark we stop
  re-arming the read; the kernel PTY buffer fills and the child blocks in
  `write(2)`, exactly as against a slow physical terminal.
- **Bytes are never dropped.** A VT stream is stateful — dropping bytes truncates
  an escape sequence and desynchronises the parser.
- Read size **128 KB**. Coalescing window **8 ms**. Drain time-slice **4 ms**, then
  yield and reschedule so one terminal cannot starve the daemon's other work.
- Parsing happens on a per-terminal serial queue. There is no main queue in the
  daemon to protect — which is the point of having moved it there.

### Memory

| Metric | Budget | Where |
| --- | --- | --- |
| Idle app, no projects | **< 60 MB** | client |
| Idle daemon, no live terminals | **< 30 MB** | daemon |
| Per idle (unstarted) terminal | **< 100 KB** — it is a struct, not a process | daemon |
| Per live terminal, default scrollback | **< 8 MB** | daemon |
| Per attached terminal, client-side render state | **< 4 MB** | client |
| Per session with no live terminals | **< 200 KB** including its layout tree | daemon |
| 40 open sessions, 4 live | **< 400 MB** across both processes | both |

The per-idle-terminal number is the one that makes the product work. It is why
`TerminalState.idle` exists and why `LiveTerminal.start()` — not `init` — is what
allocates.

The per-session number is its consequence one level up: a session is a name, a
path, a few descriptors and a small tree. Twenty sessions you have not opened must
cost less than one you have.

Scrollback lives in the daemon, once, however many clients are attached. Two clients
viewing one terminal cost one grid and two render surfaces — the memory argument for
the authoritative grid, on top of the correctness one.

### Scale targets

Janela should stay comfortable at:

- **20 projects** and **200 sessions** in the sidebar
- **40 terminals** open, **8** live simultaneously
- **6 panes** in one session's tab, all live
- a **10 GB** repository with **50** worktrees
- **4 clients** attached at once (two windows, a CLI invocation, a phone), **3** of
  them attached to the same terminal

---

## How to measure

### Signposts

Defined in `JanelaSupport/Log.swift`:

| Signposter | Covers | Process |
| --- | --- | --- |
| `Signpost.launch` | Process start → first interactive frame | app |
| `Signpost.connect` | Socket connect → handshake → first state | app |
| `Signpost.attach` | Attach request → first painted frame | app |
| `Signpost.render` | Renderer feed and redraw | app |
| `Signpost.daemonStart` | Socket activation → database open → ready | daemon |
| `Signpost.terminal` | Spawn, first byte, exit | daemon |
| `Signpost.encode` | Damage → repaint bytes, per frame per client | daemon |
| `Signpost.git` | Each git invocation | daemon |
| `Signpost.sessionCreate` | Worktree add → include copy → automation started | daemon |
| `Signpost.forge` | Each `gh`/`glab` invocation | daemon |

Signposts from two processes interleave correctly in Instruments as long as both use
the same subsystem, which is why `janelad` logs under `sh.janela.Janela` rather than
a subsystem of its own. A trace showing only one process will mislead you about
where the time went.

Use `.debug` for anything per-frame or per-chunk; it costs almost nothing when the
subsystem is not being collected.

### Instruments

- **App Launch** for the launch budget.
- **Time Profiler** with the `sh.janela.Janela` signposts overlaid. Attach to
  *both* processes; profiling only the app now shows an idle process waiting on a
  socket.
- **Allocations** for the per-terminal numbers, and to catch per-chunk allocation on
  the read path — in `janelad`, which is where that path now lives.
- **Swift Concurrency** to confirm the read path is not hopping actors per chunk.

### Reproducing a flood

```bash
# In a Janela terminal:
yes "the quick brown fox jumps over the lazy dog" | head -c 500000000
# or, more realistically:
find / -type f 2>/dev/null
```

The UI must stay interactive throughout, memory must plateau rather than climb,
and other terminals must be unaffected — including the one split beside it, which
is the case most likely to regress. Drag the divider while the flood runs: reflow
under load is where coalescing failures show up.

The daemon adds three checks, and they cover failures that were impossible before:

```bash
# 1. Socket traffic must track frame rate, not throughput.
nettop -p $(pgrep janelad)        # or sum Signpost.encode byte counts

# 2. Quit the app entirely while the flood runs. janelad must keep consuming at
#    full speed with bounded memory, and reopening must show a correct screen —
#    one repaint, not a replay.

# 3. Freeze a client mid-flood; the daemon must be unaffected.
kill -STOP $(pgrep -x Janela) ; sleep 10 ; kill -CONT $(pgrep -x Janela)
```

The third is the stalled-client budget. On `SIGCONT` the app must catch up with one
full repaint rather than a backlog, and the daemon's memory must not have grown
while the client was frozen.

---

## Rules of thumb

1. **Do not allocate per chunk on the read path.** `TerminalBytes` is
   `ContiguousArray<UInt8>` rather than `Data` for this reason. If profiling shows
   the `DispatchData` → array copy dominating, the next step is
   `DispatchSource.makeReadSource` with a reusable buffer.
2. **Do not touch the main actor per chunk.** In the client, once per frame. In the
   daemon there is no main actor at all.
3. **Do nothing eagerly.** Sessions, emulators, git reads, environment resolution:
   all lazy.
4. **Bound every buffer**, and write the bound down next to it. This now includes
   per-client output queues, not just the read path.
5. **Coalesce resizes.** A live window drag produces a continuous stream of them;
   each one is a `TIOCSWINSZ` plus `SIGWINCH` plus a full reflow. Dragging a split
   divider does the same thing to *two* terminals at once, which is why the
   coalescing window is per-frame and not per-terminal.
6. **Never block a user action on a subprocess.** git, `gh`, and automation all
   run with the UI already showing the result they will fill in.
7. **Never block a client on the daemon, or the daemon on a client.** Both
   directions are async with bounded queues, and neither waits for the other to be
   healthy.
8. **Coalesce at the boundary, not after it.** Anything sent per-byte or per-chunk
   over the socket is a bug: the point of the authoritative grid is that the daemon
   decides once per frame what is worth sending.

---

## Regressions

Performance work is only durable if it is defended. Before optimising, capture a
baseline; after, record the numbers in the PR. The throughput side of that now has
a harness; the launch budget is still the next one to grow one.

### Repaint encoding

`bun run --cwd packages/terminal bench` — five scenarios × two grids, three
attached clients each, 600 frames after a 60-frame warm-up. Run it twice on a quiet
machine and report the second run; the harness itself gates two rows (the `line
flood` feed rate against ≥ 100 MB/s, and every gated scenario's bytes/frame against
the 2 MB/s socket budget) and exits non-zero when either fails.

**Baseline — full-grid placeholder (#21).** Every mismatched revision answered with
RIS + `CSI 8 t` + `SerializeAddon.serialize`. Measured on an Apple M4, `bun`
1.3.14, `@xterm/headless` 6.0.0.

| Scenario | Grid | bytes/frame/client | MB/s @120 | encode µs/frame | feed µs/frame | CPU % of 8 ms | shared buffer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| yes flood | 80×24 | 87 | 0.010 | 155.3 | 38 413 | 482 | no |
| yes flood | 120×40 | 136 | 0.016 | 301.9 | 40 171 | 506 | no |
| line flood | 80×24 | 1 859 | 0.223 | 144.3 | 4 303 | 56 | no |
| line flood | 120×40 | 4 701 | 0.564 | 337.3 | 3 944 | 54 | no |
| build log | 80×24 | 1 491 | 0.179 | 121.3 | 6.9 | 1.6 | no |
| build log | 120×40 | 2 516 | 0.302 | 270.6 | 7.1 | 3.5 | no |
| TUI cursor move | 80×24 | 2 394 | 0.287 | 222.5 | 2.7 | 2.8 | no |
| TUI cursor move | 120×40 | 3 049 | 0.366 | 572.3 | 3.2 | 7.2 | no |
| quiet | 80×24 | 0 | 0.000 | 0.1 | 0.0 | 0.0 | yes |
| quiet | 120×40 | 0 | 0.000 | 0.1 | 0.0 | 0.0 | yes |
| SGR-heavy redraw | 80×24 | 6 014 | 0.722 | 426.2 | 46.1 | 5.9 | no |
| SGR-heavy redraw | 120×40 | 14 815 | 1.778 | 1 053.1 | 70.1 | 14.0 | no |

Feed rates: `line flood` 193.7 MB/s at 80×24 and 211.3 MB/s at 120×40; `yes flood`
21.7 and 20.7 MB/s. The first run of the pair read 202.1 / 219.4 and 30.1 / 27.7,
which is the honest spread on a machine that is not idle.

**Why `yes flood` is reported and not gated.** The ≥ 100 MB/s row above was
measured off the *PTY*, with 78-column lines. `y\r\n` is a screen scroll every three
bytes, and the emulator sustains ~20–30 MB/s of it — the emulator, not the PTY, is
the flood's bottleneck for that payload, and back-pressure is what absorbs it. Its
*wire* row is what #32 is about, and that is gated. `line flood` carries the
throughput budget on the payload the budget was measured with.
