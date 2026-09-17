# The survival proof

The one thing this repository is betting on: **a daemon owns the terminals, and the
app is only a renderer.** Everything else follows from it, and until it is
exercised end to end it is an assumption.

This is the procedure that exercises it, the verdict of the last run, and the
defects that run found. Re-run it whenever the daemon's lifecycle, the handshake,
the frame loop or the transport changes — and when it fails, believe it.

---

## Verdict, last run

Run on 2026-09-09 in **two passes**, because the first pass could not reach
launchd at all:

- **Pass A — dev build**, `apps/daemon/janelad` compiled from `04f3ea8` + this
  branch, started by hand under an isolated `HOME`. No LaunchAgent.
- **Pass B — the installed, signed bundle**: `bun run desktop:build`, copied to
  `/Applications/Janela.app`, registered as a real Login Item, its sidecar owned
  by launchd, writing to the real `~/.janela` and the real `janela.sqlite`. This
  is the pass the verdicts below come from, and it required two fixes to the app
  shell before it could talk to its own daemon at all (**D9**, **D10**).

| # | Step | Verdict |
| --- | --- | --- |
| 1 | Start a session, run a long-lived process that emits output | **Pass** — through the app's own UI, on the installed bundle |
| 2 | Quit the app entirely | **Pass** — app gone from the process table, daemon pid and child pid unchanged |
| 3 | `janelad` is still alive and the child is still running | **Pass, including the launchd half.** The daemon was launchd's own (`launchctl print` → `state = running`, `runs = 2`), the app was gone, the child was still `Rs`, and the screen advanced from ~`0036` to `0170` with nothing attached |
| 4 | Relaunch, attach, grid is correct and output continued while detached | **Pass** — 44 unbroken lines, `survival-tick-0768` → `0811`, live cursor. The wart that the selected session was not restored was filed as **D4** and is fixed since #46: the relaunched window opens on the most recently active session |
| 5 | A second client at a different viewport: the daemon resolves to the minimum, the larger client letterboxes rather than scales | **Pass, all four halves** since #44. Minimum: **pass** (`12 40`, wrapping at 40 columns). Grows back on detach: **pass** (`45 127`). Does not scale: **pass**. Letterboxes: **pass** — the negotiated grid rides the repaint as `CSI 8 ; rows ; cols t` (protocol 5) and the grid element shrinks to whole cells. It failed on the run below and was filed as **D2** |
| 6 | Restart the daemon under version skew: the connection is refused and no terminal dies | **Pass, both halves.** The launchd daemon refused a version-5 client with `incompatibleVersion`, kept serving, and its child kept producing (`0050` → `0067`). A real second build — a client at protocol 5 against the compiled daemon at 4 — showed the banner and did **not** retry |
| 7 | `SIGKILL` `janelad`: launchd restarts it and every affected session reappears as idle | **Pass, including launchd.** With **no app running**, so nothing could `kickstart` it, `kill -9` was answered by launchd in **1 second**: new pid, `runs` 2 → 3. Every session came back, every terminal `idle`, nothing respawned |

**No step required killing a terminal to recover.** That is non-negotiable 7 and
it held everywhere, including under a refused handshake and after a `SIGKILL`.

The bet itself — quit the app with work running, come back, find it still running
with a correct screen — **holds**, on the installed build, with launchd owning the
daemon. It was observed, not inferred: the emitter was at `survival-tick-0036`
when the app quit, the app was gone from the process table, the screen reached
`0170` while nothing was attached, and the relaunched window showed `0768`
through `0811` live.

### The largest unknown, now answered

**`SMAppService` accepts an ad-hoc-signed bundle.** The previous handoff called
this "the single largest unknown", because a refusal would have made the daemon's
launchd lifecycle unprovable outside a Developer ID build. It does not refuse:
`register_launch_agent` returned `registered` (not `requires-approval`, so no
approval prompt), `sfltool dumpbtm` shows the agent as
`[enabled, allowed, notified]` under parent `sh.janela.Janela`, and macOS raised
its own "Janela can run in the background" notification. `TeamIdentifier=not set`
throughout. **A local ad-hoc build is enough to exercise the whole daemon
lifecycle** — no signing identity required.

Two defects were found that no unit test could have found, and both were filed
rather than fixed on the run above: **D1** and **D2**. **Both have since been
fixed** — D1 by #43, which registers the connection handler before `listen` and
gives the client a handshake deadline, and D2 by #44, protocol 5, the negotiated
grid inside the repaint. Step 5's verdict above is therefore the re-run rather
than the original. Two more — **D9** and **D10** — were found in the app shell,
and both **are** fixed here, because with either one in place the packaged app
cannot reach its daemon at all and no verdict above could have been observed.

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
the build and the run are separate commands rather than `bun run desktop:only`.

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

### Pass B: the installed bundle, which is the only way to reach launchd

Steps 3, 6 and 7 are really about launchd, and no isolation trick reaches it: the
agent's plist is *sealed into the bundle*, `SMAppService` resolves it relative to
the running app's bundle, and there is no socket or `HOME` override that moves the
registered job. So this pass touches the real machine, and you must have the
operator's consent before starting it.

```bash
bun run desktop:build                 # ~50 s warm, several minutes cold
cp -R apps/desktop/src-tauri/target/release/bundle/macos/Janela.app /Applications/
codesign --verify --strict /Applications/Janela.app
open -a /Applications/Janela.app      # registers the Login Item on first start

launchctl print gui/$(id -u)/sh.janela.janelad | grep -E 'state =|runs =|pid ='
sfltool dumpbtm | grep -A6 janelad    # the Login Items record itself
```

What this pass costs, and what you are promising to undo:

- **Several GB** under `apps/desktop/src-tauri/target`.
- **A Login Item** in System Settings > General > Login Items. macOS also raises
  its own "Janela can run in the background" notification.
- **The real `~/.janela/run` and the real `janela.sqlite`.** Expect sessions that
  are already there; record them first (`sqlite3 … 'select id,name from Session'`)
  so you can tell yours from theirs, and remove only yours afterwards.

To undo it: **Settings > General > Background service > Stop and Unregister**, and
confirm. Then verify — do not assume the call succeeded:

```bash
launchctl print gui/$(id -u)/sh.janela.janelad   # must say: Could not find service
pgrep -f 'MacOS/janelad' || echo 'no janelad resident'
sfltool dumpbtm | grep -A6 janelad               # Disposition: [disabled, ...], not absent
rm -rf /Applications/Janela.app
```

The BTM record **survives unregistration** — measured: `Disposition: [disabled,
allowed, notified]`, `Generation: 2`, its URL still pointing at the now-deleted
bundle. Only `resetbtm` would clear it, and that resets Background Task Management
for every app on the machine, so do not. Disabled is the correct end state, not
absent; a run that expects zero matches will think it failed when it succeeded.

`launchctl bootout` is not a substitute: it stops the job but can leave the Login
Items record behind, and the promise is that System Settings looks as it did.

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

**Observed, pass A (dev build):** the child was still `-zsh`, still `Rs`, and the
screen had advanced from `survival-tick-0008` to `survival-tick-0074` with nobody
watching.

**Observed, pass B (installed bundle, daemon owned by launchd):** the app was
gone from the process table, `launchctl print gui/$(id -u)/sh.janela.janelad`
reported `state = running` with `runs = 2`, the child was still `Rs`, and the
screen advanced from ~`0036` to `0170`. **Pass, both halves** — what survived the
app is not merely a daemon someone started, it is launchd's daemon.

The idle-exit rule cannot fire here and that is the point: `isDaemonIdle` requires
no connections *and* `terminals.liveCount === 0`, so a daemon holding a running
terminal is never idle. A configured-but-never-started terminal is a different
story — it *is* idle, and a daemon holding only those exits after five minutes.

### Step 4 — relaunch, attach, and read the screen

Start the app again the same way. Then:

1. The sidebar shows the session with a green dot, **and it is already selected**
   — the most recently active session, chosen by the client from `lastActiveAt`
   in the mirror (#46, defect **D4**). Nothing to press.
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

**And the part that used to fail, re-run for #44.** The app's window, while the
PTY was 40×12:

- does **not** scale — the font is unchanged, and there is no `transform`, `scale`
  or `zoom` anywhere on the terminal surface;
- **does** letterbox now. The daemon announces the negotiated grid inside the
  repaint as `CSI 8 ; rows ; cols t` (protocol 5), the client resizes to it, and
  the grid element shrinks to whole cells so the rest of the pane shows the
  container through. Lines wrap at 40.

What to expect when re-running it, and how to tell a pass from a near-miss:

- **The grid is anchored top-left, not centred.** The letterbox is the remainder,
  visible; centring it is a product decision nobody has taken. What matters for
  this step is that the live area is *marked* — the terminal's own background ends
  where the grid ends — and that the text is not scaled.
- **The client must not vote the announcement back.** Read its viewport votes: a
  client that echoes the daemon's number as its own proposal can never grow again,
  because the minimum would then be its own. `xtermRendering` resizes without
  calling `onViewportChange`, and `terminal.onResize` is deliberately unwired.
- Measured with the real renderer against bytes captured from the real daemon: a
  1040×744 pane at an 8.8×18.4 px cell held 118×40 of its own, was announced
  12×40, resized to it, and its grid element went from 1038×737 px to 352×221 —
  a 688×523 px letterbox — with one recorded vote throughout, its own. Reverting
  the resize handler leaves the client at 118×40; reverting the letterbox leaves
  the element at 1038×737, which is what a 40-column screen filling a 127-column
  pane looked like.

### Step 6 — version skew

The honest way to stage this at the protocol level needs no source edit at all,
because a newer client is just a client that says so:

```bash
HOME=$ISO bun run scripts/survival-probe.ts --attach <id> --protocol-version 6
```

**Observed:**

```
REFUSED: {"kind":"incompatibleVersion","daemonMinimum":5,"daemonCurrent":5}
```

that connection closed, and nothing else moved: the daemon kept serving, the child
kept running, the other client kept working, and the daemon never logged
`hung up every terminal`. **Pass.** The automated test asserts all of this, and
mutation-checking it is what proves the assertion is load-bearing.

For the app's side of the story you need two builds, because the version lives in
one file both binaries read (`packages/protocol/src/handshake.ts`). Set
`PROTOCOL_VERSION` **and** `MINIMUM_SUPPORTED_VERSION` to one past the shipped
version — bumping only the first still overlaps and is compatible — then run a
client built from *that* tree
against the compiled daemon built from the unedited one. A dev client is enough:
it reads the frontend from Vite, so the edit needs no rebuild of the daemon.

**Observed:** the client logged
`handshake refused {"refusal":"incompatibleVersion"}`, went to
`{"kind":"refused"}`, tore the connection down and **did not retry** — one
refusal, no reconnect loop. The banner read, verbatim:

> Janela was updated. The background service is still running your terminals on
> the previous version. Restart it when you are ready — this will close your
> terminals.

No raw stderr in it, and the button states its cost before it is pressed
(non-negotiables 10 and 7). Meanwhile the launchd daemon and its child were
untouched: same pids, and the emitter advanced `0050` → `0067` across the whole
episode. **Pass, both halves.**

**Two warnings:** `bun test` fails while that edit is in place (`frame.test.ts`
pins the version, deliberately), so never commit it — revert it and confirm
`git diff` is empty; and **do not press the banner's button** (see § Rules).

### Step 7 — `SIGKILL`

Run this against the **installed bundle**, and run it with **no app open** — an
app would `kickstart` the daemon on the next failed connect, and then you cannot
tell launchd's `KeepAlive` from the app's retry. That distinction is the whole
step.

```bash
pgrep -f 'MacOS/janela$'              # must be empty, or attribution is lost
DPID=$(pgrep -f 'MacOS/janelad')
ORPHANS=$(pgrep -P "$DPID")           # capture BEFORE the kill; see below
launchctl print gui/$(id -u)/sh.janela.janelad | grep -E 'runs|pid ='
kill -9 "$DPID"
for i in $(seq 1 20); do sleep 1; pgrep -f 'MacOS/janelad'; done   # watch for a NEW pid
launchctl print gui/$(id -u)/sh.janela.janelad | grep -E 'runs|pid ='
bun run scripts/survival-probe.ts
```

**Observed:** launchd replaced the daemon **after one second**, with no client in
existence to ask it to — a new pid, and `runs` went 2 → 3. The replacement found
the stale socket, unlinked it, rebound, and restored **all four** sessions from
SQLite with **every terminal `idle`** and nothing spawned. The relaunched app
showed the session with its running indicator gone. **Pass, including launchd** —
and recovery needed no `rm`, no repair, and no terminal killed by us.

Three things to expect:

- **The child dies, and that is the kernel, not us.** The PTY master lives in the
  daemon; `SIGKILL` closes it, the slave gets `SIGHUP`, the shell exits. A
  `SIGKILL`ed daemon cannot avoid this, which is exactly *why* step 7 asks for
  sessions "reappearing as idle" rather than still running. Non-negotiable 7
  governs our deliberate choices; it is not a promise to survive `kill -9`.
- **Any child that does outlive it is orphaned, not reaped.** `SIGKILL` skips
  `hangUpAll()`. Do not read a surviving orphan as a terminal that survived, and
  clean them up: `kill -9 $ORPHANS`.
- **The socket file outlives the process.** That is the case the replacement must
  handle, and it does.

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

Step 5's client half is not in that file, because it is not the daemon's: the
announcement is asserted byte for byte in `packages/terminal`, against a real PTY
and a real emulator, and the render is a browser check rather than a test — this
repository has no DOM under `bun test` and deliberately adds none.

| Test | What it defends |
| --- | --- |
| `a receiver at the wrong size learns the negotiated grid from the repaint` (`headless-emulator.test.ts`) | the sequence is in `fullRepaint`, and a stock `@xterm/headless` acts on it |
| `a smaller client joining is announced to the client already attached` | the client that has to letterbox is told |
| `an overruled viewport is answered with the negotiated size, not silence` | the case where the negotiation does **not** move |
| `growing back when the smaller client detaches is announced too` | the other direction |
| `a client told its size is owed nothing on the next frame` | it is a debt, not a per-frame prefix |
| `reaches every attached client even when the encoder only sends deltas` | the constraint #32's damage encoder must keep passing |

| Guard reverted | Test that goes red |
| --- | --- |
| `CSI 8 ; rows ; cols t` in `fullRepaint` (`packages/terminal/src/headless-emulator.ts`) | a receiver at the wrong size learns the negotiated grid |
| the per-client debt in `applySize` (`packages/terminal/src/live-terminal.ts`) | reaches every attached client even when the encoder only sends deltas |
| the overruled-viewport debt in `attach` (same file) | an overruled viewport is answered with the negotiated size |
| the full path in `repaintFor` (same file) | an overruled viewport is answered with the negotiated size |
| `PROTOCOL_VERSION` / `MINIMUM_SUPPORTED_VERSION` (`packages/protocol/src/handshake.ts`) | the negotiated grid on the wire is a wire change: version 5 |
| the `CSI 8` handler in `xtermRendering` (`packages/terminal-ui`) | *browser check*: the client stays at its own grid, which is D2 |
| the letterbox call on the daemon-driven path (same file) | *browser check*: the grid resizes and the element does not |

---

## Defects

### D1 — a client that connected while the daemon was starting was swallowed, forever

**Severity: high. FIXED by #43**, and kept here because the measurement is what
made the fix a design change rather than a reordering. `bindDaemonSocket` called
`server.listen()`, awaited it, then `await chmod(path, 0o600)` and returned; only
afterwards did `socketListener()` register `server.on("connection")`. A connection
accepted inside that window was emitted with no listener, so the socket was
created, dropped, and never spoken to. The peer saw a healthy, open, silent
socket.

**Measured:** a client that spun on `connect` and handshook immediately was never
answered, **10 times out of 10**. One that waited was always answered, and a
swallowed connection did not poison later ones.

It did not stop there, because `@janela/client` awaited the daemon's hello with no
deadline of its own (`packages/client/src/connection.ts`, the `first.value` read).
Only the daemon had a handshake deadline, and it never armed one — it never made a
`Connection`. **Observed** by pointing the app at a listener that accepted and
said nothing: after 25 seconds the app was still `{"kind":"connecting"}`, one
status transition, no retry, no timeout, an empty sidebar and a permanent
"Connecting…". The user's sessions were all still there and completely invisible.

The reason this mattered more than a start-up race usually would: the app's only
way to start a daemon is `bridge_connect` failing, running `launchctl kickstart`,
and retrying with a 250 ms backoff. That retry aimed *straight at the window*. It is
the first-launch path and the after-a-crash path — steps 3 and 7 of this very
document.

**The fix.** Two changes in two packages, and the second was a design call:
register the connection handler before `listen` (which means constructing the
listener before `bindDaemonSocket` binds, so the shape of that seam changed), and
give the client a handshake deadline so a silent peer becomes a retry instead of a
hang. `apps/daemon` + `packages/daemon` + `packages/client`.

**Fixed by #43.** The listener is constructed before the bind, `bindDaemonSocket`
refuses a server with no `connection` handler (and `socketListener` refuses one
that does not pause what it accepts, or the queued socket's first bytes are read
off and dropped), and `@janela/client` gives the daemon `HANDSHAKE_DEADLINE_MS`
(5 s) to answer hello — a miss is a retry under the usual backoff, not a refusal.
`survival.test.ts`'s readiness is a bare `connect` again.

### D2 — nothing on the wire carried the negotiated size, so a larger client could not letterbox

**Severity: high for this document's step 5, medium for a user. FIXED by #44 —
protocol 5.** The daemon resolved the minimum correctly and the PTY got it; no
client was ever told. What was missing, and what closed it:

- `DaemonMessage` has no size, and neither does `StateUpdate`. It still does not:
  the grid now rides the repaint as `CSI 8 ; rows ; cols t`, emitted by
  `fullRepaint()` between its RIS and the screen, because it describes the very
  bytes it travels with. `ClientConnection.attach` still returns a `GridSize` the
  dispatcher ignores, and that is now correct rather than a leak: the announcement
  is the terminal's own bookkeeping, not the request handler's.
- `PtyLiveTerminal` owes each client the news, and re-owes it on two events, not
  one: the negotiation moving, **and** an attach whose viewport is overruled. The
  second is the case an "on change" design misses — resize the window while a
  smaller client holds the minimum and the negotiated size does not move, so
  nothing would ever correct that client again.
- `letterboxMargins(box, cell, grid)` in `packages/terminal-ui` is now handed a
  grid the daemon chose. `grid-fit.test.ts`'s fixture is derived from
  `gridThatFits` instead of hand-fed, so it cannot again describe a value no call
  site can produce.
- **The client needed code after all, and this is the finding worth keeping.**
  `@xterm/xterm` 6.0.0 gates `CSI 8 t` on `windowOptions.setWinSizeChars` and then
  implements **no case for parameter 8** — `InputHandler.windowOptions()` handles
  14, 16, 18, 22 and 23 and falls off the end. Measured: a terminal with the flag
  set, fed `\x1b[8;12;40t`, stays at its old size. The flag is still required,
  because `InputHandler.registerCsiHandler` wraps any custom `{final:"t"}` handler
  in the same gate and swallows the sequence when it is off. So `xtermRendering`
  registers the handler and performs the resize itself, hands every other
  parameter back to the library, and casts **no vote** doing so — echoing the
  minimum back as a proposal is how a minimum would become permanent.

**What it cost before the fix:** with the PTY at 40×12 and the app's grid at
127×45, the app painted the small screen top-left with the surplus blank and no
indication why, wrapping lines at 127.

### D3 — the daemon's log is unreachable exactly when you need it

**Severity: medium. FIXED by #45.** The daemon's sink wrote one JSON record per
line to **stderr**, and the LaunchAgent plist declared no `StandardOutPath` or
`StandardErrorPath`. `LOG_SUBSYSTEM` was exported by `@janela/support` and read by
nothing, so `docs/development.md`'s `log stream --predicate 'subsystem == …'`
found nothing either. On a real install, steps 3, 6 and 7 could not be diagnosed at
all. The daemon now writes to a rotated file under
`~/Library/Logs/sh.janela.Janela/janelad.log` — the same place under launchd and in
`--foreground`, where it is also mirrored to stderr — and `LOG_SUBSYSTEM` is gone.

It bites in development too: stderr over a pipe is buffered, so records arrive
late. During this run a failing case showed a daemon log ending at `listening`
while the daemon had in fact served a client, created a session and spawned a
shell — the records only appeared once the process died and the pipe flushed. Any
assertion of the form "the log does not contain X" is weak for this reason; assert
on process and child state instead.

### D4 — after the survival moment, the app opens on "No session selected" — fixed (#46)

**Severity: low, and a product call.** Selection is local view state by design —
no protocol message carries it, and none should — so a relaunch selected nothing.
With exactly one session, the one whose agent you came back to check on, the first
frame was an empty pane and a green dot, and the user had to press ⌘⇧O or click.

**Fixed in #46**, and still local: `createStores().mirror.apply` seeds
`SessionStore.selection` with the most recently active session whenever nothing is
selected, read from the `lastActiveAt` the mirror already carries. No new field, no
protocol message, no persistence — the answer is recomputed from the daemon's state
on every launch. The guarantee is *the first frame that **shows** the session shows
it selected*: an empty mirror still renders "No session selected", because no client
can select a session it has not been told about.

### D5 — `nextRequestID()` is a shipped export that throws

**Severity: low. FIXED by #47.** `packages/protocol/src/message.ts` exports
`nextRequestID(): RequestID` whose body is `throw new Error("not implemented:
nextRequestID")`, and nothing in the repository calls it — every client mints its
own ids. Both it and `isAutomation(role)` in `packages/core/src/terminal.ts` —
same shape, also uncalled — are deleted; a caller that ever needs one writes it
then.

### D6 — turbo does not know where the sidecar is written

**Severity: low, but it fails confusingly. FIXED by #48.** `turbo.json` declares
`build` outputs as `dist/**`; `@janela/janelad`'s build writes
`apps/daemon/janelad`. Every build prints `WARNING no output files found for task
@janela/janelad#build`, and on a cache *hit* turbo replays the logs and restores
nothing — so `bun run daemon:build` can report success while leaving no binary on
disk, and `sidecar.ts` then fails at `copyFileSync` with `ENOENT`.
`apps/daemon/turbo.json` now declares `janelad` (and the `--sourcemap` sibling
`main.js.map`) as the build's output, so a cache hit restores the binary;
verified by building, deleting the binary, and building again.

### D7 — `docs/development.md` § The daemon documents commands that do not exist

**Severity: low. FIXED by #49.** It printed `make daemon-restart` (there is no
Makefile; it is `bun run daemon:restart`), `.build/debug/janelad --socket
/tmp/janela-dev.sock --foreground` (the Swift-era path, and **`--socket` was not
parsed** — it was silently ignored, and the daemon bound the real user socket
instead, which is a genuinely dangerous thing to hand someone mid-procedure), and an
`os_log` predicate that matched nothing (D3).

`janelad` now **refuses any argument it cannot honour**, exit 2, before it opens
anything, and its usage text names the recipe that works. `--socket` was deliberately
not implemented: a socket-only override leaves the database shared, so two daemons
would restore the same sessions — a worse footgun than the one removed. `HOME=` moves
the socket and the database together, which is what this document uses.

### D8 — one test's timeout is load-sensitive, and this suite is the load

**Severity: low, and found by accident. FIXED by #50.** `packages/git`'s
`"a cross-device copy falls back, says so, and still delivers the bytes"` builds a
RAM disk through `crossDeviceVolume()` and runs under `bun test`'s default 5 s
timeout. It passes alone every time. It failed once here at exactly 5000 ms, in a
`bun run check` where the survival suite was also copying a 71 MB binary seven
times — an `hdiutil` attach does not care whose I/O it is queued behind.

The survival suite now copies once instead of seven times, and three forced full
runs afterwards were clean, so the symptom is gone. The fragility is not: a test
that attaches a volume needs an explicit timeout, the way `packages/pty`'s slow
tests already carry `45_000`. Both tests that attach a volume in that file now
carry `45_000`.

### D9 — registration was unreachable, so no install ever armed the daemon

**Severity: high. Release blocker. Fixed on this branch.**

`register_launch_agent` read `service.status()` and early-returned unless it was
exactly `NotRegistered`:

```rust
if status != SMAppServiceStatus::NotRegistered {
    return Ok(describe(status).to_string());
}
```

macOS reports an agent that has **never been registered** as `NotFound`, not
`NotRegistered`. So on every real install the guard fired, `registerAndReturnError`
was never called, no Login Item was ever created — and because the bundled plist
has no `RunAtLoad` and the daemon starts only via `launchctl kickstart`, there was
no service to kickstart. The app logged `launch agent {"status":"not-found"}` and
then `daemon-unavailable` forever. **A shipped Janela could not start its daemon
at all**, from `/Applications` or from the build directory.

Independent confirmation, before any code was changed —
`backgroundtaskmanagementd`:

```
effectiveItemDisposition: record not found: appURL=/Applications/Janela.app,
  url=/Contents/Library/LaunchAgents/sh.janela.janelad.plist, type=agent
```

The fix is the condition: only `Enabled` and `RequiresApproval` mean "nothing to
do". With it, `register_launch_agent` returns `registered` and the Login Item
appears — which is what made steps 3, 6 and 7 provable.

**Why no test caught it:** `agent()` returns `unsupported` for any executable
outside `Contents/MacOS`, so every test and every `tauri dev` run takes the
early-out before reaching the status check. This code path only exists in a
bundle, and nothing before this run had ever executed it.

### D10 — the packaged app could not send a single frame to its daemon

**Severity: high. Release blocker. Fixed on this branch.**

With D9 fixed and the daemon running, the packaged app still could not connect.
`bridge_connect` succeeded and every `bridge_send` failed with
`expected-raw-body`, so the hello never went out:

```
protocol: hello not sent {"error":"expected-raw-body"}
protocol: connection torn down {"reason":"hello not sent"}
```

The cause is the CSP. Tauri's IPC has two paths (`tauri-2.11.5/scripts/ipc-protocol.js`):
the custom protocol sends a `Uint8Array` as `application/octet-stream`, which
arrives as `InvokeBody::Raw`; if that `fetch` is blocked it falls back to
`postMessage`, which JSON-stringifies the whole envelope and turns the bytes into
an array of numbers — `InvokeBody::Json`, which `bridge_send` correctly refuses.
The fallback's own comment names the trigger: *"either the webview blocked a
custom protocol or it was a CSP error"*.

`tauri.conf.json` declared `default-src 'self'` and **no `connect-src`**, and
`ipc://localhost` is not `'self'`. Fix, which is the value Tauri's own
documentation prescribes:

```
"csp": "default-src 'self' ipc: http://ipc.localhost; style-src …"
```

**Why no test caught it, and why nobody noticed in development:** in dev the
frontend is served by Vite over `http://localhost:1420`, which never carries the
bundle's CSP, so the custom-protocol fetch is allowed and the raw path works. The
failure exists **only** in the packaged app. `transport.test.ts` injects the
`invoke` seam and asserts the exact bytes handed to it — correctly, and it cannot
see a CSP. This is the whole class of bug the issue's "the compiled sidecar is
what must be tested" clause exists for, applied to the client instead.

Both D9 and D10 are one-line changes with no behavioural ambiguity, and both were
declared rather than folded silently into the test commit: the verdicts above were
observed on a bundle rebuilt and re-verified **with both fixes in place**
(`bundle ok — adhoc — janela, janelad hardened; sh.janela.janelad.plist sealed`).

---

## What was not tested, and what it would take

The launchd halves of steps 3, 6 and 7 **were** tested in the end, on an
installed, ad-hoc-signed bundle with a real Login Item; see § Verdict. What
remains untested is narrower.

**A Developer ID build.** Everything here ran on `signingIdentity: "-"` with
`TeamIdentifier=not set`. `SMAppService` accepted it, which is the surprising and
useful result — but a notarized, stapled build is a different code identity, and
`smd` is entitled to treat it differently. Nothing about *this* run predicts a
notarized one. What it takes: release credentials and
`APPLE_SIGNING_IDENTITY=… bun run desktop:build`.

**`requires-approval`.** Registration returned `registered` directly, so the
approval path — `SMAppService` returning `RequiresApproval`, the app's degraded
mode, and `openSystemSettingsLoginItems` — never ran. It is reachable by denying
the item in System Settings > General > Login Items and relaunching.

**Programmatic unregistration.** `unregister_launch_agent` is bundle-relative:
only `Janela.app` itself can call `SMAppService.unregister` for its own agent, so
it cannot be driven from a script, and the only path to it is the settings
surface's **Stop and Unregister** (which asks for confirmation first — observed).
`launchctl bootout` is *not* equivalent: it stops the job but can leave the Login
Items entry behind. Anyone re-running this procedure must budget for pressing that
button by hand.

**Reboot.** Sessions surviving a *reboot* is a larger promise than Janela makes,
and nothing here tests one.

**Deltas.** `repaintSince` is still a placeholder that answers any revision
mismatch with a whole grid, so every repaint observed here was a full one. Nothing
in this document asserts incremental repaints, because there are none to assert.
