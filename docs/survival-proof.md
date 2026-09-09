# The survival proof

The one thing this repository is betting on: **a daemon owns the terminals, and the
app is only a renderer.** Everything in [ADR 0015](decisions/0015-daemon-owned-sessions.md)
follows from it, and until it is exercised end to end it is an assumption.

This is the procedure that exercises it, the verdict of the last run, and the
defects that run found. Re-run it whenever the daemon's lifecycle, the handshake,
the frame loop or the transport changes — and when it fails, believe it.

Related: [ADR 0015](decisions/0015-daemon-owned-sessions.md) (the daemon owns
sessions), [ADR 0016](decisions/0016-daemon-protocol.md) (the protocol and the
minimum-viewport rule), [ADR 0017](decisions/0017-daemon-lifecycle.md) (launchd,
idle exit, version skew), [ADR 0020](decisions/0020-bun-daemon-runtime.md) (the
compiled sidecar).

---

## Verdict, last run

Run on 2026-09-09 against `apps/daemon/janelad` compiled from `04f3ea8` + this
branch, and the Tauri shell built from the same tree.

| # | Step | Verdict |
| --- | --- | --- |
| 1 | Start a session, run a long-lived process that emits output | **Pass** — through the app's own UI |
| 2 | Quit the app entirely | **Pass** |
| 3 | `janelad` is still alive and the child is still running | **Pass** for the daemon and its child. The *launchd* half is untested — see § What was not tested |
| 4 | Relaunch, attach, grid is correct and output continued while detached | **Pass**, with one wart: which session was selected is not restored |
| 5 | A second client at a different viewport: the daemon resolves to the minimum, the larger client letterboxes rather than scales | **Split.** Minimum: **pass**. Grows back on detach: **pass**. Does not scale: **pass**. **Letterboxes: fail** — no mechanism exists (defect **D2**) |
| 6 | Restart the daemon under version skew: the connection is refused and no terminal dies | **Pass** at the protocol level, against the compiled daemon. The app's banner under two real builds is untested |
| 7 | `SIGKILL` `janelad`: launchd restarts it and every affected session reappears as idle | **Pass** for the recovery half — a replacement daemon rebinds and restores every session as idle, and recovery kills nothing. **launchd's part is untested** |

**No step required killing a terminal to recover.** That is non-negotiable 7 and
it held everywhere, including under a refused handshake and after a `SIGKILL`.

The bet itself — quit the app with work running, come back, find it still running
with a correct screen — **holds**. It was observed, not inferred: the emitter was
at `survival-tick-0008` when the app quit, the app was gone from the process
table, and the relaunched window showed `survival-tick-0216` through `0259` live.

Two defects were found that no unit test could have found. Both are filed rather
than fixed here, because both need a decision in a lower package: see § Defects.

---

## Requirements

| Thing | Why |
| --- | --- |
| macOS 15+, this repository bootstrapped | `bun run bootstrap` once |
| A short `$HOME` for the fixture | The daemon derives its socket from `homedir()` and refuses a path over `sun_path`'s 104 bytes. A fixture under macOS's per-user `TMPDIR` makes it 109 and the daemon correctly declines to start. Use `/tmp` |
| No `janelad` of your own holding work | `bun run daemon:status`. If one is running, **stop and think** — do not kill it |

## Rules, which are not negotiable

- **Never `bun run daemon:restart` during the procedure.** It is `pkill -x janelad`,
  which is `SIGTERM`, which is the *graceful* path: the daemon hangs up every
  terminal and exits 0. It destroys exactly the state the procedure measures.
- **Never press "Restart the background service"** on the version-skew banner
  during step 6. It runs `launchctl kill TERM`, which hangs up every terminal. It
  is the correct button for a user who has read the sentence above it, and the
  wrong button for someone gathering evidence.
- **Never `kill -9` a `janelad` you did not start.** It may be holding somebody's
  agent. Step 7 kills the daemon *you* started, in the isolated home below.

---

## Isolation: how to run this without touching your own sessions

The daemon has no `--socket` flag — `apps/daemon/src/main.ts` parses `--version`
and `--foreground` and nothing else — but both its socket and its database come
from `homedir()`. So one environment variable moves its whole world:

```bash
# A short home, for sun_path's sake.
export ISO=/tmp/jsurv
mkdir -p "$ISO/work"

# The COMPILED sidecar, which is what ships. Not `bun run src/main.ts`.
bun run daemon:build                      # -> apps/daemon/janelad, about 200 ms
HOME=$ISO TMPDIR=$ISO ./apps/daemon/janelad --foreground
```

That daemon binds `$ISO/.janela/run/janelad.sock` and writes
`$ISO/Library/Application Support/sh.janela.Janela/janela.sqlite`. Your own
`~/.janela` is untouched, and a resident daemon cannot interfere.

Point the app at the same world. A dev build has no LaunchAgent, so nothing starts
the daemon for you and nothing needs to:

```bash
bun run --cwd apps/desktop sidecar                        # the sidecar the app carries
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml   # with your real HOME, so cargo keeps its cache
(cd apps/desktop && bunx vite)                            # the dev server on :1420
HOME=$ISO TMPDIR=$ISO apps/desktop/src-tauri/target/debug/janela
```

Overriding `HOME` for `cargo` would make it re-download the registry, which is why
the build and the run are separate commands rather than `bun run app`.

Expect this in the app's log, and it is not a failure:

```
app: launch agent {"status":"unsupported"}
```

`agent.rs` reports `unsupported` for any executable outside `Contents/MacOS`, so a
dev build registers no LaunchAgent and never tries to start the daemon.

### The second client

Steps 4, 5 and 6 need a client whose viewport a human chooses; the app's is
whatever its window measures. `scripts/survival-probe.ts` is that client — a
socket, `@janela/protocol`'s framing, and nothing else. It never creates, starts
or stops anything.

```bash
HOME=$ISO bun run scripts/survival-probe.ts                       # what is running
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --columns 40 --rows 12 --hold 30
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --send 'stty size\n'
```

---

## The procedure

### Step 1 — a session with a long-lived process

In the app: **⌘O**, pick `$ISO/work`. A session appears with a running shell. Type
a process that keeps emitting:

```bash
i=0; while :; do i=$((i+1)); printf 'survival-tick-%04d\n' $i; sleep 0.5; done
```

Confirm from outside the app that the daemon owns it:

```bash
HOME=$ISO bun run scripts/survival-probe.ts        # the session and a `running` terminal
DPID=$(pgrep -f 'apps/daemon/janelad'); pgrep -P "$DPID"   # the shell is the daemon's child
```

**Observed:** session `work`, terminal `running`, one child of the daemon, ticks
climbing. `stty size` in the pane reported `45 127`. **Pass.**

### Step 2 — quit the app entirely

Note the tick number, then **⌘Q**. Check that the app is really gone rather than
merely windowless, and that nothing followed it:

```bash
pgrep -x janela                    # empty
ps -p "$DPID" -o pid=,command=     # the daemon is still there
pgrep -P "$DPID"                   # the same child pid as before
```

**Observed:** app gone; daemon alive; child `98340` unchanged and still `Rs`.
**Pass.**

### Step 3 — the daemon and the child are still running

This is step 2's assertion made deliberately, after a wait long enough that
nothing is merely in flight. With no client attached at all:

```bash
sleep 12
ps -p <child pid> -o pid=,stat=,command=
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --hold 1
```

**Observed:** the child was still `-zsh`, still `Rs`, and the screen had advanced
from `survival-tick-0008` to `survival-tick-0074` with nobody watching. **Pass.**

The idle-exit rule cannot fire here and that is the point: `isDaemonIdle` requires
no connections *and* `terminals.liveCount === 0`, so a daemon holding a running
terminal is never idle. A configured-but-never-started terminal is a different
story — it *is* idle, and a daemon holding only those exits after five minutes.

> **What this step does not prove.** The daemon here was started by hand, so what
> survived the app is the daemon and its child — not launchd's grip on them. The
> launchd half needs a bundled `Janela.app`; see § What was not tested.

### Step 4 — relaunch, attach, and read the screen

Start the app again the same way. Then:

1. The sidebar shows the session with a green dot. **It is not selected** — press
   **⌘⇧O** and Return to select it (defect **D4**).
2. Read the pane.

**Observed:** the pane showed `survival-tick-0216` … `0259`, continuing from the
`0008` of step 2 — so output continued while detached, the screen is current, and
it is not a replay from tick 1. **Pass.**

Two things worth knowing when this step goes wrong:

- **A repaint is the screen, not the history.** `fullRepaint()` serialises with
  `{ scrollback: 0 }`. Progress made while detached is only in the scrollback, so
  prove it with `snapshotText` (the probe prints it) or with a process that is
  still emitting — never by expecting old lines in the repaint.
- **A restored terminal is not restarted.** `startsAutomatically` is false for
  everything the database restores, so the app attaches to the process that
  survived. If you see tick numbers starting from 1, something started a new
  shell and the bet has failed.

### Step 5 — two clients, two sizes

With the app attached, attach the probe deliberately smaller and hold it:

```bash
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --columns 40 --rows 12 --hold 45
```

Then ask the child — the only party that cannot be wrong about its own window —
by typing into the app's pane:

```bash
stty size
```

**Observed:** `12 40` while both were attached, against the app's own `45 127`. The
daemon resolved to the per-axis minimum. After the probe detached, `stty size`
reported `45 127` again: the size grows back. **Pass**, twice.

**And the part that fails.** The app's window, while the PTY was 40×12:

- did **not** scale — the font was unchanged, and there is no `transform`, `scale`
  or `zoom` anywhere on the terminal surface;
- did **not** letterbox either. The 40-column screen was rendered into the app's
  still-127-column grid, anchored top-left, with the rest of the pane blank and
  nothing marking the live area. Lines wrapped at 127, not at 40.

That is defect **D2**, and it is not a rendering bug: nothing on the wire tells a
client what the negotiated size is, so the client has nothing to letterbox *to*.

### Step 6 — version skew

The honest way to stage this at the protocol level needs no source edit at all,
because a newer client is just a client that says so:

```bash
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --protocol-version 5
```

**Observed:**

```
REFUSED: {"kind":"incompatibleVersion","daemonMinimum":4,"daemonCurrent":4}
```

that connection closed, and nothing else moved: the daemon kept serving, the child
kept running, the other client kept working, and the daemon never logged
`hung up every terminal`. **Pass.** The automated test asserts all of this, and
mutation-checking it is what proves the assertion is load-bearing.

For the app's side of the story you need two builds, because the version lives in
one file both binaries read (`packages/protocol/src/handshake.ts`). Set
`PROTOCOL_VERSION` **and** `MINIMUM_SUPPORTED_VERSION` to 5 — bumping only the
first still overlaps and is compatible — rebuild the app, and leave the old
daemon resident. Expect the version-skew banner. **Two warnings:** `bun test`
fails while that edit is in place (`frame.test.ts` pins the version, deliberately),
so never commit it; and do not press the banner's button.

### Step 7 — `SIGKILL`

```bash
DPID=$(pgrep -f 'apps/daemon/janelad')
ORPHANS=$(pgrep -P "$DPID")        # capture BEFORE the kill; see below
kill -9 "$DPID"
ls -l "$ISO/.janela/run/janelad.sock"   # still there, stale
HOME=$ISO TMPDIR=$ISO ./apps/daemon/janelad --foreground   # launchd's job, done by hand
HOME=$ISO bun run scripts/survival-probe.ts
```

**Observed (automated, see below):** the replacement daemon found the stale socket,
unlinked it, rebound, and restored the session from SQLite with its terminal
**idle** and nothing spawned. Starting it again worked normally. **Pass** — and
recovery needed no `rm`, no repair, and no terminal killed.

Two things to expect:

- **The old children are orphaned, not reaped.** `SIGKILL` skips `hangUpAll()`, so
  the shells are reparented and keep running invisibly. That is what "terminals
  are gone, sessions restored as idle" means in ADR 0017 — do not read a surviving
  orphan as a terminal that survived, and clean them up: `kill -9 $ORPHANS`.
- **`launchctl` is what this step is really about**, and a hand-started daemon
  cannot show it. See below.

---

## What the automated test covers

`apps/daemon/src/survival.test.ts` runs the daemon's half of all seven steps
across two real processes, and it is the only test in the repository that runs the
**compiled sidecar** — built by the package's own `build` script, copied into a
directory containing nothing else, and started with an isolated `HOME`. It takes
about thirteen seconds and runs inside `bun run check`.

CI already proves that binary *runs* from an empty directory (`./janelad
--version`, which deliberately touches nothing). This proves it *works* from one:
it binds its socket, migrates its database, and spawns a real PTY through a dylib
that exists only inside the executable — a path `--version` never touches.

| Test | Step |
| --- | --- |
| `spawns a real PTY from a directory containing nothing but itself` | 1 |
| `keeps a terminal running, and keeps draining it, with every client gone` | 1–3 |
| `sends a reattaching client the current screen, not a blank one` | 4 |
| `answers an attach with the screen, and keeps the history only in the scrollback` | 4 |
| `sizes the pty to the minimum of two attached viewports, and grows it back` | 5 |
| `refuses a newer client without touching a single terminal` | 6 |
| `after SIGKILL its replacement rebinds the stale socket and restores every session as idle` | 7 |

Each was mutation-checked: the invariant it defends was reverted in turn and
exactly the named test went red.

| Guard reverted | Test that goes red |
| --- | --- |
| the `{ type: "file" }` dylib import (`packages/pty/src/bindings.ts`) | spawns a real PTY |
| `feed(terminal)` for unwatched terminals (`packages/daemon/src/frame-loop.ts`) | keeps a terminal running |
| `{ full: true }` for a fresh attachment (`packages/daemon/src/frame-loop.ts`) | not a blank one |
| `serialize({ scrollback: 0 })` (`packages/terminal/src/headless-emulator.ts`) | history only in the scrollback |
| the per-axis minimum in `negotiatedSize` (`packages/terminal/src/live-terminal.ts`) | minimum of two viewports |
| the range overlap in `isCompatible` (`packages/protocol/src/handshake.ts`) | refuses a newer client |
| the stale-socket `unlink` (`apps/daemon/src/socket.ts`) | after SIGKILL |

---

## Defects

### D1 — a client that connects while the daemon is starting is swallowed, forever

**Severity: high.** `bindDaemonSocket` calls `server.listen()`, awaits it, then
`await chmod(path, 0o600)` and returns; only afterwards does `socketListener()`
register `server.on("connection")`. A connection accepted inside that window is
emitted with no listener, so the socket is created, dropped, and never spoken to.
The peer sees a healthy, open, silent socket.

**Measured:** a client that spins on `connect` and handshakes immediately is never
answered, **10 times out of 10**. One that waits is always answered, and a
swallowed connection does not poison later ones.

It does not stop there, because `@janela/client` awaits the daemon's hello with no
deadline of its own (`packages/client/src/connection.ts`, the `first.value` read).
Only the daemon has a handshake deadline, and it never armed one — it never made a
`Connection`. **Observed** by pointing the app at a listener that accepts and says
nothing: after 25 seconds the app was still `{"kind":"connecting"}`, one status
transition, no retry, no timeout, an empty sidebar and a permanent "Connecting…".
The user's sessions are all still there and completely invisible.

The reason this matters more than a start-up race usually would: the app's only
way to start a daemon is `bridge_connect` failing, running `launchctl kickstart`,
and retrying with a 250 ms backoff. That retry aims *straight at the window*. It is
the first-launch path and the after-a-crash path — steps 3 and 7 of this very
document.

**Fix sketch, and why it is not done here.** Two changes in two packages, and the
second is a design call: register the connection handler before `listen` (which
means constructing the listener before `bindDaemonSocket` hands back a listening
server, so the shape of that seam changes), and give the client a handshake
deadline so a silent peer becomes a retry instead of a hang. `apps/daemon` +
`packages/daemon` + `packages/client`.

**Workaround in the meantime:** readiness means "the daemon answered a hello", not
"the socket accepted me". That is what `startDaemon` in the automated test does,
and it is why it retries; `scripts/survival-probe.ts` says so when it gets nothing.

### D2 — nothing on the wire carries the negotiated size, so a larger client cannot letterbox

**Severity: high for this document's step 5, medium for a user.** The daemon
resolves the minimum correctly and the PTY gets it. No client is ever told.

- `DaemonMessage` has no size, and neither does `StateUpdate`.
- `ClientConnection.attach` *returns* the negotiated `GridSize` and the dispatcher
  throws it away: `connection.attach(terminal, viewport); return { type: "acknowledged", id }`.
- `fullRepaint()` is `ESC c` plus `SerializeAddon.serialize(...)`, which never
  emits `CSI 8 ; rows ; cols t`.
- `letterboxMargins(box, cell, grid)` in `packages/terminal-ui` is only ever
  passed xterm's own measured grid, so it can absorb sub-cell rounding and nothing
  else. The seam comment at `xterm-rendering.ts` says as much: *"Nothing on the
  wire delivers the negotiated PTY size today, so this is the seam rather than a
  feature."*
- `grid-fit.test.ts`'s `"a grid smaller than the box letterboxes the difference"`
  hand-feeds `{ columns: 60, rows: 10 }` with a comment describing a second
  attached client — a value no call site can produce. **The helper is tested; the
  feature does not exist.** That is what made this look shipped.

**Observed cost:** with the PTY at 40×12 and the app's grid at 127×45, the app
paints the small screen top-left with the surplus blank and no indication why.
A user with a phone attached would see a large mostly-empty pane and no
explanation.

**Fix sketch:** the client side needs no code — a daemon-emitted
`CSI 8 ; rows ; cols t` resizes xterm's grid, and `letterboxMargins` then receives
a grid genuinely smaller than the box. So the change is in the daemon's repaint
path, or a size on `DaemonMessage`. Either is a wire change, and
[ADR 0016](decisions/0016-daemon-protocol.md) has no minor versions: protocol 5.

### D3 — the daemon's log is unreachable exactly when you need it

**Severity: medium.** The daemon's sink writes one JSON record per line to
**stderr**, and the LaunchAgent plist declares no `StandardOutPath` or
`StandardErrorPath`. `LOG_SUBSYSTEM` is exported by `@janela/support` and read by
nothing, so `docs/development.md`'s `log stream --predicate 'subsystem == …'`
finds nothing either. On a real install, steps 3, 6 and 7 cannot be diagnosed at
all.

It bites in development too: stderr over a pipe is buffered, so records arrive
late. During this run a failing case showed a daemon log ending at `listening`
while the daemon had in fact served a client, created a session and spawned a
shell — the records only appeared once the process died and the pipe flushed. Any
assertion of the form "the log does not contain X" is weak for this reason; assert
on process and child state instead.

### D4 — after the survival moment, the app opens on "No session selected"

**Severity: low, and a product call.** Selection is local view state by design —
no protocol message carries it, and none should — so a relaunch selects nothing.
With exactly one session, the one whose agent you came back to check on, the first
frame is an empty pane and a green dot, and the user has to press ⌘⇧O or click.
The moment the whole product is built for deserves a better first frame; "select
the only session" and "select the most recently active" are each one line, and
neither invents a new noun.

### D5 — `nextRequestID()` is a shipped export that throws

**Severity: low.** `packages/protocol/src/message.ts` exports
`nextRequestID(): RequestID` whose body is `throw new Error("not implemented:
nextRequestID")`, and nothing in the repository calls it — every client mints its
own ids. Delete it or implement it; an exported function that throws is a trap for
the CLI author who finds it by autocomplete.

### D6 — turbo does not know where the sidecar is written

**Severity: low, but it fails confusingly.** `turbo.json` declares `build` outputs
as `dist/**`; `@janela/janelad`'s build writes `apps/daemon/janelad`. Every build
prints `WARNING no output files found for task @janela/janelad#build`, and on a
cache *hit* turbo replays the logs and restores nothing — so `bun run daemon:build`
can report success while leaving no binary on disk, and `sidecar.ts` then fails at
`copyFileSync` with `ENOENT`. Escape hatch: `bun run --cwd apps/daemon build`.

### D7 — `docs/development.md` § The daemon documents commands that do not exist

**Severity: low.** It prints `make daemon-restart` (there is no Makefile;
it is `bun run daemon:restart`), `.build/debug/janelad --socket /tmp/janela-dev.sock
--foreground` (the Swift-era path, and **`--socket` is not parsed** — it is silently
ignored, and the daemon binds the real user socket instead, which is a genuinely
dangerous thing to hand someone mid-procedure), and an `os_log` predicate that
matches nothing (D3). The file carries a stale-stack banner, but this section is
worse than stale: following it touches the daemon holding your own work.

### D8 — one test's timeout is load-sensitive, and this suite is the load

**Severity: low, and found by accident.** `packages/git`'s
`"a cross-device copy falls back, says so, and still delivers the bytes"` builds a
RAM disk through `crossDeviceVolume()` and runs under `bun test`'s default 5 s
timeout. It passes alone every time. It failed once here at exactly 5000 ms, in a
`bun run check` where the survival suite was also copying a 71 MB binary seven
times — an `hdiutil` attach does not care whose I/O it is queued behind.

The survival suite now copies once instead of seven times, and three forced full
runs afterwards were clean, so the symptom is gone. The fragility is not: a test
that attaches a volume needs an explicit timeout, the way `packages/pty`'s slow
tests already carry `45_000`. Left for whoever owns that file — this branch does
not edit it.

---

## What was not tested, and what it would take

**launchd.** Steps 3, 6 and 7 each have a launchd half that a dev build cannot
reach: `agent.rs` returns `unsupported` for any executable outside
`Contents/MacOS`, so `tauri dev` registers no LaunchAgent, and
`launchctl kickstart` targets a service that does not exist. Untested, therefore:

- that `KeepAlive.SuccessfulExit=false` restarts a `SIGKILL`ed daemon;
- that `SMAppService.agentServiceWithPlistName` accepts an ad-hoc-signed bundle,
  and whether it needs approval in Login Items first — nothing in the repository
  records an observed outcome either way;
- that the app's reconnect loop recovers a session list after launchd restarts the
  daemon underneath it.

What it takes: `bun run app:build` (a cold 506-crate release build), installing the
produced `Janela.app`, letting it register a **Login Item** on the machine, and
`kill -9`ing the daemon that then holds the real `~/.janela` and the real
`janela.sqlite`. That is a change to the operator's System Settings and their own
data, so it is deliberately not something this procedure does on its own
initiative. If `SMAppService` refuses the ad-hoc bundle, the fallback is
`launchctl bootstrap gui/$UID <bundle>/Contents/Library/LaunchAgents/sh.janela.janelad.plist`,
which loads the same shipped plist by hand — that would prove `KeepAlive` but not
registration, and the two must be reported separately rather than as one tick.

**The app's version-skew banner.** Step 6 was proven at the protocol level with a
probe that claims version 5. The banner, its running-session summary and its button
need two real builds; see step 6.

**Deltas.** `repaintSince` is still a placeholder that answers any revision
mismatch with a whole grid, so every repaint observed here was a full one. Nothing
in this document asserts incremental repaints, because there are none to assert.
