# Performance

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

| Metric | Budget | Measured by |
| --- | --- | --- |
| Cold launch → interactive window | **250 ms** | `Signpost.launch`, Instruments App Launch |
| Warm launch → interactive window | **120 ms** | same |
| Database open + first read | **15 ms** | `Signpost.launch`, interval `store.load` |

Rules that protect this:

- **Nothing blocks first paint except opening the database.** Resolving the user's
  shell environment, refreshing git state, and checking which agent binaries exist
  all happen *after* the window is on screen.
- **No session is started during launch.** Restored tabs come back `.idle`.
- **Avoid adding dynamic library dependencies.** This is one of the reasons for
  [ADR 0005](decisions/0005-persistence.md): SwiftData would pull Core Data onto
  the launch path.

### Interaction

| Metric | Budget |
| --- | --- |
| Workspace switch (both live) | **1 frame** — it is showing a view, not starting work |
| New session → first prompt | **150 ms** beyond the shell's own startup |
| Keystroke → glyph on screen | **1 frame** |
| Sidebar refresh after a git change | **50 ms**, off the main actor |

### Terminal throughput

The hard case: a session producing output faster than we can render it — `yes`, a
verbose build, `cat` of a large file.

| Metric | Budget |
| --- | --- |
| Sustained throughput without UI stall | **≥ 100 MB/s** |
| Frame rate during a flood | **≥ 60 fps** |
| Memory growth during a sustained flood | **bounded** — see below |
| One flooding session's effect on others | **none measurable** |

The mechanism, specified in `ByteStream.swift` and
[ADR 0003](decisions/0003-concurrency-model.md):

- High-water mark **4 MB**, low-water **1 MB**. Past the high mark we stop
  re-arming the read; the kernel PTY buffer fills and the child blocks in
  `write(2)`, exactly as against a slow physical terminal.
- **Bytes are never dropped.** A VT stream is stateful — dropping bytes truncates
  an escape sequence and desynchronises the parser.
- Read size **128 KB**. Coalescing window **8 ms**. Drain time-slice **4 ms**, then
  yield and reschedule so one session cannot starve the UI.
- Parsing happens on a per-session serial queue, never the main queue.

### Memory

| Metric | Budget |
| --- | --- |
| Idle app, no workspaces | **< 60 MB** |
| Per idle (unstarted) session | **< 100 KB** — it is a struct, not a process |
| Per live session, default scrollback | **< 8 MB** |
| 40 open sessions, 4 live | **< 400 MB** |

The per-idle-session number is the one that makes the product work. It is why
`SessionState.idle` exists and why `TerminalSession.start()` — not `init` — is what
allocates.

### Scale targets

Janela should stay comfortable at:

- **200 workspaces** in the sidebar
- **40 sessions** open, **8** live simultaneously
- a **10 GB** repository with **50** worktrees

---

## How to measure

### Signposts

Defined in `JanelaSupport/Log.swift`:

| Signposter | Covers |
| --- | --- |
| `Signpost.launch` | Process start → first interactive frame |
| `Signpost.session` | Spawn, first byte, exit |
| `Signpost.render` | Emulator feed and redraw |
| `Signpost.git` | Each git invocation |

Use `.debug` for anything per-frame or per-chunk; it costs almost nothing when the
subsystem is not being collected.

### Instruments

- **App Launch** for the launch budget.
- **Time Profiler** with the `sh.janela.Janela` signposts overlaid.
- **Allocations** for the per-session numbers, and to catch per-chunk allocation on
  the read path.
- **Swift Concurrency** to confirm the read path is not hopping actors per chunk.

### Reproducing a flood

```bash
# In a Janela session:
yes "the quick brown fox jumps over the lazy dog" | head -c 500000000
# or, more realistically:
find / -type f 2>/dev/null
```

The UI must stay interactive throughout, memory must plateau rather than climb,
and other sessions must be unaffected.

---

## Rules of thumb

1. **Do not allocate per chunk on the read path.** `TerminalBytes` is
   `ContiguousArray<UInt8>` rather than `Data` for this reason. If profiling shows
   the `DispatchData` → array copy dominating, the next step is
   `DispatchSource.makeReadSource` with a reusable buffer.
2. **Do not touch the main actor per chunk.** Once per frame, to mark dirty
   regions.
3. **Do nothing eagerly.** Sessions, emulators, git reads, environment resolution:
   all lazy.
4. **Bound every buffer**, and write the bound down next to it.
5. **Coalesce resizes.** A live window drag produces a continuous stream of them;
   each one is a `TIOCSWINSZ` plus `SIGWINCH` plus a full reflow.

---

## Regressions

Performance work is only durable if it is defended. Before optimising, capture a
baseline; after, record the numbers in the PR. When a benchmark harness lands, the
throughput and launch budgets are the first two things it should assert.
