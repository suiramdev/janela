# @janela/janelad

Layer 7, daemon side: `apps/daemon`, compiled into the `janelad` executable the
bundle carries. It owns the process — argv, the log file, the socket bind, the
signals, idle exit — and nothing else. Per
[`architecture.md`](../architecture.md) § Daemon side it **must not contain
anything testable**, which is a statement about `main.ts`: everything with
behaviour was pushed one file sideways, into `environment.ts`, `socket.ts`,
`lifecycle.ts` and `log-file.ts` beside it, and from there down into
`@janela/daemon` and below, where it can be exercised without a process.

It is nevertheless where the survival proof lives, because the artifact that
proof is about is this package's own `build` output. See
[`survival-proof.md`](../survival-proof.md) and § Tests below.

There is no socket activation, despite the table in `architecture.md` naming it:
the plist declares no `Sockets` block. What remains of the idea is on the client
side — see § socket.ts.

## main.ts

Deliberately thin. If something here would be worth a test, it belongs in a
sibling module.

**One compiled binary.** `bun build --compile` embeds the Bun runtime, the Prisma
client, the emulator and the PTY cdylib, and the result runs from a directory
containing nothing else. Verified in the migration spikes and asserted by
`survival.test.ts`, which runs it from a directory holding only the executable.

**`JANELAD_VERSION` is a literal, not an import of `package.json`.** Importing
the manifest would make `bun build --compile` embed it, and a daemon whose
version depends on a file being next to it reports the wrong version from a
bundle. The app's own version lives in `tauri.conf.json`; the two are released
together.

**A refused argument stops the process before it opens anything** — before
`defaultDatabasePath()`, before any `mkdir`, before the log sink — so an argument
the daemon cannot honour leaves no socket, no database and no log file behind.
The defect this closes (#49) was that `--socket` was *silently ignored*.
`--version` likewise touches nothing else: CI runs `./janelad --version` from an
empty directory to prove the compiled binary carries its own runtime, and that
must never start serving.

**The daemon owns its log file because nothing else can.** Under launchd its
stderr is `/dev/null`: the LaunchAgent declares no `StandardErrorPath` and could
not name a per-user one, so on a real install the records went nowhere (#45).
`--foreground` mirrors the same lines to stderr *synchronously*, so a
developer's pipe shows a record when it happens rather than when the event loop
next turns.

**A failed start exits non-zero.** The interesting error is a failed migration:
it means the daemon cannot start, and the only way a user learns about it is a
client that cannot connect. A zero exit would let `KeepAlive` spin. Only the
error's *class* is logged.

**Signals.** `process.once` for `SIGTERM` and `SIGINT`, so a second signal while
the sweep is in flight does not start a second one; the sweep never goes harder
than `SIGHUP`, because terminating a user's terminals is always their explicit
choice (AGENTS.md non-negotiable 7). `SIGPIPE` is ignored explicitly: a client
vanishing mid-write is routine and must never kill a daemon holding another
client's terminals. Bun follows Node in ignoring `SIGPIPE` and surfacing `EPIPE`
on the socket instead, which `socketTransport` absorbs — the handler is there so
a runtime that does not cannot take us down.

**Process lifetime is one `Effect.scoped` program.** Finalizers release in
reverse acquisition order — idle monitor, then the database, then the log sink —
so anything the shutdown path logs is still on disk. The signal path is the
exception and always was: `shutdown` ends with `process.exit`, so nothing after
it runs.

## arguments.ts

`argv` is untrusted input, so the recognised flags are a `Schema.Literals` and an
argument that does not decode is a refusal. There is no shell anywhere (AGENTS.md
§ Conventions: argv is always an array), so there is no quoting bug class to
worry about — only an unhonoured request to worry about.

The defect (#49) was not a missing flag: `main` asked
`argv.includes("--foreground")` and nothing else, so
`janelad --socket /tmp/dev.sock --foreground` bound the *real* user socket and
served the real database while a developer believed they were isolated.

**There is deliberately no `--socket`.** It would move the socket and leave the
database where it was, so two daemons would restore the same sessions into two
sets of terminals — a worse footgun than the one being removed. `HOME` moves the
socket, the database and the log together, which is what the survival proof does
and what `USAGE` points at.

The *first* unknown argument stops it rather than a collected list: one is enough
to stop, and naming exactly the one that was refused is what makes the message
actionable. `--version` wins wherever it appears.

## environment.ts

The composition root — `daemonEnvironment()` is the one place the real daemon
graph is assembled, the same shape as `liveEnvironment()` in the app. Injection
is through parameters; there is no service locator and no module-level mutable
state, which is also what makes the whole graph substitutable in
`@janela/daemon`'s tests.

**What startup does, and what it deliberately does not.** It opens the database,
migrates it, captures the login shell's environment once, and loads projects and
sessions **from the database only**. That is the whole of "sessions restore as
idle": nothing probes git, nothing refreshes forge state, and above all nothing
spawns a process — a configured terminal that has not been started costs nothing
(non-negotiable 5). The first client to connect is waiting on all of it; see
[`performance.md`](../performance.md) § Launch.

A migration failure is left to propagate, so `main` can log it and exit non-zero.

**The bind path is identical under launchd and in `--foreground`**, deliberately,
so a mode cannot drift between a developer's machine and a user's.

**Two cycles, both broken with a deferred reference rather than a setter.** The
server observes the services and the services announce through the server;
removing a project stops its sessions' terminals, and the session service does
not exist when the project service is built. Before `server` exists nothing can
have subscribed, so an announcement in that window has nobody to reach and
dropping it is correct rather than lossy. `createDaemonServer` takes no
`dispatch`: it builds `createRequestDispatch` itself and binds `settled` to the
terminal-event relay it is constructing, which is the one wiring this root
cannot do from outside.

**`process.getuid` is optional in the types, and the peer check is the whole of
the socket's authorization**, so a daemon that cannot name its own uid refuses to
serve.

**The listener is constructed before the bind.** `socketListener` is what puts
the `connection` handler on the server, and a connection accepted before one
exists is dropped by the runtime with the peer none the wiser (#43). Sockets
accepted before the accept loop runs wait in the listener's bounded `pending`
queue.

**The accepted socket's descriptor is decoded, not asserted.** It lives on Bun's
undeclared `_handle`, so a `Schema.Struct` reads it and a miss is `None` — the
same treatment `packages/pty/src/peer-credential.test.ts` gives Bun's undeclared
socket `fd`. If a Bun upgrade removes the property, every peer is refused as
`credential-unavailable` — fail-closed, never fail-open — and the fix is a native
`accept` beside the other `jpty_*` exports.

`serve()` returns without serving when another daemon already answers on the
path. The caller exits 0: a non-zero exit would make
`KeepAlive.SuccessfulExit=false` respawn us into the same collision.

## socket.ts

**Why the daemon binds its socket and launchd does not.** Socket activation was
on offer and was given up (#39): the only *static* form launchd offers,
`SecureSocketWithKey`, publishes the socket path solely into the GUI login
session's launchd environment, which a CLI over ssh cannot read — and the daemon
needs an address that survives launchd. So the plist declares no `Sockets` block,
there is no descriptor to inherit, and there is no second FFI surface: `bun:ffi`
stays gated to `@janela/pty`.

The property socket activation was chosen for is kept on the client side
instead. The agent has no `RunAtLoad`, so nothing runs until a client fails to
connect and runs `launchctl kickstart gui/<uid>/sh.janela.janelad`. A user who
never opens Janela never has a process. That cold connect is budgeted in
[`performance.md`](../performance.md) § Launch, and it is paid once per daemon
lifetime rather than once per launch.

**This is the one bind path.** The launchd start and `--foreground` are the same
code, so the mode, the directory check and the stale-file handling cannot drift.

`SOCKET_FILE_MODE` is `SockPathMode`'s replacement now that the plist declares no
socket: launchd used to be able to set it and nothing does it for us any more.
The 0700 directory is the primary defence, the peer-uid check the second, and
this the third, for one syscall.

**Creating the directory 0700 is not the same as it being 0700** — it may have
existed already, with any mode and any owner — so `verifySocketDirectory` checks
it. That refusal is left to propagate: the socket is a capability, since anything
that can connect can start processes as this user.

**Liveness is a connect attempt, not a lock file or a pid file.** The socket *is*
the lock, and it is the only thing whose liveness matters to a client. An
`AF_UNIX` connect is answered by the kernel from the listener's backlog, so the
probe neither waits on the incumbent's accept loop nor needs a timeout.

Whatever is left on the path when nothing answers is a leftover from a daemon
that was killed. `bind` fails with `EADDRINUSE` against *any* existing file, and
unlinking one nobody answers on is the only way a daemon recovers from `SIGKILL`;
`ENOENT` is the normal case, the first ever start.

`sun_path` is 104 bytes — `MAXIMUM_SOCKET_PATH_LENGTH` in
`packages/daemon/src/endpoint.ts`, which measures rather than truncates. It is
why a test fixture's `HOME` goes under `/tmp`; see § Tests.

## lifecycle.ts

Two rules, and the whole of the lifecycle is them:

1. **A daemon holding live terminals never exits on its own.** Not when the last
   client disconnects, not when it has been idle for an hour. That asymmetry is
   the entire feature — the daemon exists to outlive clients, not to serve them
   (non-negotiable 7). `isDaemonIdle` needs *both* conjuncts, and dropping the
   second would make the daemon exit five minutes after the user closed the
   window on a running build.
2. **Hang up before exiting.** `shutdown`'s order is the contract: `hangUpAll()`
   first, so children get `SIGHUP` from a parent that still exists. A process
   that closed its listener and exited first would leave every shell reparented
   onto launchd, running, invisible, and holding the worktree the user was about
   to delete. It exits 0, so `KeepAlive.SuccessfulExit=false` leaves the daemon
   down. Idempotence comes from the call site — `process.once` per signal, and
   the idle monitor stops itself before calling this.

**The grace period is five minutes**, and this is the first place it exists as
code. Long enough that quitting and reopening the app does not tear down and
rebuild the world — the database, the shell-environment capture, the session
restore — and short enough that a user who is done for the day is not left with a
process. An idle period interrupted by a reconnect restarts from **zero** rather
than resuming: a daemon that exits four minutes into a session the user just
opened is a bug.

**Idleness is polled every fifteen seconds, not driven by events.** "Idle" is a
conjunction of two things that change independently — clients and live terminals
— and a timer armed and cancelled on every transition is a timer that leaks one.
Fifteen seconds costs nothing and bounds the overshoot at 5% of the grace period.
The interval is `unref`ed, because the daemon must not hold the process open just
to ask whether it is idle; that is also why this stayed a plain interval rather
than becoming a sleeping fiber, which would have to re-earn the `unref`.

`poll()` is public so a test can drive the state machine with an injected clock:
the behaviour worth testing is "an idle period interrupted by a reconnect starts
again", and waiting five real minutes to see it is not a test anybody runs.

## log-file.ts

A file the daemon owns, one JSON record per line, at
`~/Library/Logs/sh.janela.Janela/janelad.log` — beside the `Janela.log` Tauri's
log plugin writes. The bundle identifier is spelled here, in `@janela/db`'s
`defaultDatabasePath()` and in `tauri.conf.json`; all three must agree.

**Why a file, and why the daemon opens it.** Before this (#45) the daemon wrote
records to stderr, and on a real install stderr is `/dev/null`: launchd takes a
literal path with no `~` expansion, and the plist is sealed into the bundle and
validated against its code signature, so the only path it could name is one
shared by every user of the machine. The daemon's log therefore did not exist
anywhere, and steps of the survival proof could not be diagnosed at all.
`os_log` is not the alternative: reaching it from Bun needs `bun:ffi`, which
`scripts/layers.ts` gates to `@janela/pty`, or a subprocess per record. A file
the daemon opens itself behaves identically under launchd and in `--foreground`,
and derives from `homedir()` like the socket and the database, so `HOME=/tmp/…`
isolates all three together.

**The bound.** A log file is the classic place where "no unbounded buffers"
(non-negotiable 9) is forgotten, because the accumulation is on disk rather than
in memory. Rotation at `LOG_FILE_LIMIT_BYTES` with exactly one previous file kept
caps it at twice that — 8 MiB — for a daemon that may run for months. Three
consequences the code states and the tests pin: an existing file's size counts at
open, so a daemon restarted every hour cannot append past the bound one restart
at a time; the rotation happens *before* the line that would cross the limit; and
a line larger than the whole limit still lands, because rotating an empty file
would rotate forever and drop every record.

**What may not reach it.** Non-negotiable 11: terminal traffic, command output,
file contents, notification bodies and environment values are the user's private
data, and this file is the first place in the daemon that makes a record easy to
read back. No daemon-side `log(...)` call passes content today — the survey
behind #45 found only ids, counts, exit statuses, error names, a truncated client
name, a shell path and a forge CLI name — so the elision is a **backstop, not a
filter**: any string value shaped like a body is replaced by its length. "Shaped
like a body" means longer than `FIELD_VALUE_LIMIT`, or carrying a C0 control,
`DEL`, or anything in the C1 range, which the named code constants say and a scan
checks (a literal control character inside a regular expression is usually a
mistake). So a leak lands as `<4096 characters elided>` rather than as the first
paragraph of the user's output, and the file is safe to `tail`: an escape
sequence out of somebody's shell cannot drive a reader's own terminal through it.
The limit is generous for every field the daemon logs — the longest is a path —
and far shorter than any body worth leaking. `elideFields` returns the original
object when nothing needs eliding, so the common record costs no copy.

`formatRecord` adds `time` first and `LogRecord` stays isomorphic: a browser
client's console adds its own timestamp and the app's log plugin already has one.
The rule that a record with no fields carries **no `fields` key** comes from
[`support.md`](support.md) § log.ts, and so does the reviewer's test for a new
field.

**Writes are synchronous**, so a record is on the descriptor when `write`
returns: a daemon that crashes must not take its last records with it. They also
**never throw** — a full disk, a revoked directory or a descriptor someone closed
is captured as a `Result` and dropped, because a log is not worth a daemon.
`--foreground` mirrors with `writeSync(2, …)` rather than `process.stderr.write`,
which queues once the pipe fills and flushes only when the event loop turns —
measured at 1.5 s behind a busy loop, which is exactly when a developer is
reading.

With no file at all, stderr is everything there is: under launchd that is
`/dev/null`, but a daemon must still start. The reason the file is unavailable is
reported as an errno — `ENOTDIR` when the directory is a file, `EEXIST` when
`mkdir -p` meets one, `EACCES` when it is not ours — decoded with a `Schema`
rather than sniffed, and never as a message, because a message would quote the
path.

## index.ts

The package's entry point, so a sibling can name the graph rather than the
process: `main.ts` is argv, signals and a log sink, and everything with behaviour
is exported from here.

## Tests

A package that must contain nothing testable has 1700 lines of tests, and the two
facts are compatible.

- `arguments.test.ts`, `lifecycle.test.ts`, `socket.test.ts`, `log-file.test.ts`
  and `environment.test.ts` test the modules *beside* `main.ts` — the ones
  behaviour was pushed into — and need no process at all. `environment.test.ts`
  binds a **real** Unix socket and connects real clients, because every
  interesting bug at this boundary is a real-socket bug: a partial read, a frame
  split across two `recv` calls, a peer that vanishes mid-frame, a length prefix
  that lies.
- `main.test.ts` makes the two claims that are only true of a *process*: an
  argument the daemon does not understand stops it before it touches anything,
  and its log exists as a file on disk.
- `survival.test.ts` is the end-to-end survival proof across two real processes,
  and the only test that runs the **compiled sidecar**. The procedure, the
  verdicts, and what the automated half deliberately does not claim — launchd,
  incremental deltas, what the window looks like — are in
  [`survival-proof.md`](../survival-proof.md). Nothing in it is faked.

Three things that bite once each:

- **Fixtures go under `/tmp`, not `temporaryDirectory()`.** The daemon derives
  its socket from `homedir()` and refuses a path over `sun_path`'s 104 bytes; a
  macOS per-user `TMPDIR` spends about 50 of those before any label, which makes
  `<home>/.janela/run/janelad.sock` 109 bytes and the daemon correctly declines
  to start. Each home is still unique, because `bun test` runs files in parallel.
- **The cross-process tests poll real time, deliberately.** The condition lives
  in a separate operating-system process with its own timers, so there is no
  clock here to advance. The predicate is the assertion: a failure names the
  condition that never became true rather than reporting a timeout, and the
  passing path returns as soon as the other process has answered. The timeouts
  are backstops sized for a freshly copied 70 MB binary's first signature
  evaluation and a heavy `~/.zshrc` on the daemon's login-shell capture.
- **The sidecar is built once for the file**, by the package's own `build` script
  rather than a second copy of its flags, so every test runs the same bytes and
  the artifact under test is the one the bundle ships. See AGENTS.md § Commands
  for what may and may not be run against a resident `janelad` — in particular
  that `daemon:restart` is `SIGTERM`, which is the graceful path and destroys
  exactly the state the proof measures.
