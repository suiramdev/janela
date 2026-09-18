# @janela/support

Layer 0, with zero domain knowledge: logging, user-facing errors, timing marks,
bounded buffers, and the one subprocess runner.

## index.ts

Everything reachable from this entry must be usable from either process, and one
of the two processes is a WebView — so it touches no filesystem, no socket and no
child process. The subprocess runner lives behind the `@janela/support/process`
subpath instead, which `scripts/layers.ts` gates to the daemon side along with
`node:child_process`.

## errors.ts

`UserFacingError` is a class rather than an interface because it must survive an
`instanceof` across the daemon/client decision: the daemon decides what is
user-facing, and the wire form is `UserFacingFailure` in `@janela/protocol`,
which is deliberately lossy.

`message` is for the log; `summary`, `reason` and `recoverySuggestion` are for the
person. Keeping them apart is the whole point of the type — a raw error message or
a git stderr dump in a dialog headline becomes a bug report, not a recovery path.

`summary` is one short sentence with no error codes and no jargon. `presentation`
defaults to `{}` so the ~25 subclasses that call `super(message)` with one
argument keep working.

`UnexpectedFailure.underlying` stays in the log. Only `summary` and the recovery
suggestion reach a person.

## log.ts

Never `console.log`: it is unsearchable, it is not levelled, and in the daemon it
goes somewhere nobody reads. Never log file contents, command output, environment
values, notification bodies, or the paths `.worktreeinclude` copied — log the
*shape*: a subcommand and its exit status, a terminal id and its state
transition, a file count and a total size. A reviewer's test for a new field in
`LogRecord.fields` is "would I mind finding this in a bug report I did not
write?". Prefer `debug` for anything on a hot path.

The sink is injected because the two processes answer it differently: the daemon
writes one JSON record per line to a file it rotates under
`~/Library/Logs/sh.janela.Janela/` (`apps/daemon/src/log-file.ts`) and mirrors the
same lines to stderr when it runs `--foreground`; a client writes through the
Tauri log plugin, and a future browser client to the console. That is what keeps
this module isomorphic enough to link into a WebView.

Until `setLogSink` is called, records are dropped rather than printed, so a
library that logs during import cannot decide the format for everyone.
`nullLogSink` is the default for that reason, and is what tests use when they do
not care — `@janela/test-support` has a recording one for when they do.

A record carries no `fields` key at all when there are none: under
`exactOptionalPropertyTypes` `{ fields: undefined }` is a different type from a
record without the key, and a sink writing `"fields": null` for every record is
noise.

The categories are one per subsystem, and the same set in both processes so a
daemon log and a client log can be read side by side. `automation` records which
event fired, which command index and its exit status — never the command's
output, which belongs in its terminal where the user can see it. `forge` and
`git` record the subcommand and failure class, never the JSON or full output.
`protocol` records connections, handshakes and subscription churn, never
payloads. `pty` is a hot path.

`currentSink` is module-level mutable state, and the only such state in the
repository: a logger is the one dependency it would be absurd to thread through
every constructor, and `setLogSink` is called once by a composition root before
anything logs. It is declared after `nullLogSink` because a `const` is not
initialised until its statement runs.

## signpost.ts

Every `SignpostName` corresponds to a budget in `docs/performance.md`. If you add
a mark, add its budget too, otherwise it is decoration rather than a test.

`launch` is process start to interactive window, client-side. `connect` is
connect plus handshake plus first full state. `attach` is attach to first painted
frame (client) or attach to first full repaint encoded (daemon). `terminal` is
PTY spawn to first byte, daemon-side. `repaint` is one `repaintFor` or
`fullRepaintFor` for one client — daemon-side and hot. `sessionCreate` is worktree
add, `.worktreeinclude` copy, automation started: the one user-initiated flow with
real work in it. `forge` is never on a path anything waits for.

These replaced platform signpost intervals read in a native profiler. The sink
mirrors `setLogSink`, so the daemon can record intervals into its log and a
browser composition root can turn them into `performance.measure` entries its own
profiler shows. The budgets did not change; how we watch them did.

**Deliberately not `performance.mark`/`measure` in here.** Both keep a timeline
entry per call, and `repaint` runs once per frame per attached client for the life
of a daemon — an unbounded buffer by non-negotiable #9. A sink that wants profiler
entries may call `performance.measure` itself, and pay for the choice where it is
visible.

With no sink, `begin` allocates nothing and reads no clock: it returns one shared
frozen object whose `end` does nothing. That is the production default, it is why
`repaintFor` may call `begin` per frame per client, and the object is frozen
because an accidental write to it would be a bug that only showed up under a
profiler. `Signpost.observed` is false then, so callers skip building `fields`.

The sink is read at `begin` rather than at `end`, so an interval never records
into a sink that was not installed when it started — otherwise a duration would
span an unmeasured stretch and read as a stall.

`SignpostFields` carries shapes only — a count, an id, a byte total — never
terminal traffic, command output or environment values (non-negotiable #11): a
sink writes to the same system log the rest does.

## bounded.ts

There are exactly four places in Janela that accumulate: the PTY read buffer
(bounded in `@janela/pty`, in Rust, by high/low water marks), the emulator's
scrollback (bounded by `@xterm/headless`), a per-client output queue, and the
frame length a socket reader will accept (bounded in `@janela/protocol`). Two of
those four use what is here.

The two overflow policies are not interchangeable and the choice is a correctness
decision, not a tuning one:

- `block` — the producer waits. Correct for terminal *input*: dropping a keystroke
  is data loss the user can see.
- `dropOldest` — the oldest entry is discarded. Correct only for *coalesced
  repaints*, where a newer frame supersedes an older one and the next full repaint
  recovers anything lost. Never correct for raw byte streams: a dropped byte
  truncates an escape sequence and desynchronises the parser until the next full
  repaint, which is not a recovery, it is a corruption with a delay.

Reaching `capacity` is a normal condition, not an error. `onDrop` exists so a
queue that sheds says so in a log.

`boundedQueue` is a ring buffer, one parked consumer, and a FIFO of blocked
producers. Single consumer by construction: `next()` parks exactly one resolver,
and a second concurrent `next()` is a caller bug rather than a queue that quietly
interleaves two `for await` loops over one stream. A freed slot goes to the oldest
blocked producer in the same step, so `block` never leaves capacity unused.

After `finish()` a `push` resolves and discards the item: the consumer is gone, a
producer that awaited forever there would be a leak, and one that threw would make
"the client disconnected" an error path in every caller. Blocked producers are
released rather than rejected for the same reason — the item is lost because the
consumer went away, which is not the producer's error. A consumer breaking out of
`for await` calls `finish()` so it cannot leave producers blocked on a queue
nobody will drain again.

A capacity that is not a positive integer raises `RangeError`: a zero-capacity
queue is not a bound, it is a queue that drops everything.

In the ring, `undefined` marks a free slot, which is why items are taken out
rather than left behind.

`TERMINAL_WATER_MARKS` is measured, not guessed. 4 MB is roughly a second of a
`yes` flood at the rate the native reader sustains — long enough that a normal
frame never touches the mark, short enough that a stalled consumer costs bounded
memory. With the consumer stopped entirely, resident memory grew by ~4 MB and then
stopped. The low mark is a quarter of the high one so the producer resumes in long
runs rather than stuttering at the boundary; that is also why there are two marks
and not one. See `docs/performance.md` § Terminal throughput.

## process.ts

**Daemon-only.** `@janela/git` and `@janela/forge` are peers and must never import
each other, so the plumbing they share lives here. `scripts/layers.ts` gates this
subpath to the daemon side and gates `node:child_process` to this package.

**Arguments are always an array. There is no shell, so there is no quoting and no
injection.** A caller who genuinely wants a shell writes `["zsh", "-lc", "…"]` and
has chosen that explicitly. The one exception lives above this layer: an automation
script is handed verbatim to the user's login shell, because a lifecycle hook *is*
the user's shell logic (`AGENTS.md` § argv) — nothing here composes it.

`ProcessRequest.executable` is resolved by the caller; this layer does not search
`PATH` for `run`. `arguments` excludes `argv[0]`. An absent `environment` means an
*empty* environment, not an inherited one: the interface promises the caller
decides exactly what the child sees. An absent `timeoutMs` means no limit, which
is only correct for something a user is watching.

`ProcessRunning` is a protocol rather than a function so tests can substitute a
recording fake — which is what automation, attention-policy and forge tests do,
because the logic under test is the decision, not the subprocess. Git is *not*
faked: see `docs/testing.md`.

### Output is not capped here

stdout and stderr are collected whole. That is safe for what the daemon runs
through this — git porcelain output bounded by repository size, `gh`/`glab` JSON,
`log -n 1` — and it is the caller's job to keep it that way. Terminal traffic never
comes through here; it goes through `@janela/pty`, which has a bounded scrollback
for exactly this reason (AGENTS.md § no unbounded buffers).

### Failure to start versus failure to succeed

A failure to *start* — no such executable, not executable — rejects rather than
returning an outcome: there was no process, so there is no exit status to report.
A non-zero exit, and a timeout kill, are outcomes. `timedOut` distinguishes the
kill from a non-zero exit.

The timeout sends `SIGKILL` rather than `SIGTERM`: the point of the limit is that
nobody is watching, so a process ignoring `SIGTERM` would hang the caller forever.

The outcome is resolved on `close`, not `exit`: `exit` can fire before the pipes
are drained, and then we would decode a truncated stdout.

### which

`which` decides whether an executable is there before we commit to running it: an
integration is offered only when its harness is on the user's `PATH`, a command a
terminal was asked to run is resolved before the PTY is spawned, and a missing
`gh` is silence rather than an error banner.

A path-ish name (one containing `/`) is not searched for — it is checked where it
points.

The `PATH` search is sequential on purpose. `PATH` is ordered and the first hit
wins; statting every entry at once would also touch directories *after* the match,
and a `PATH` can name a slow network mount. That is what the
`oxlint-disable-next-line no-await-in-loop` in the loop is for.

`process.env.PATH` is deliberately never consulted: the caller's `path` argument
is the whole search space, because the daemon's own environment is not the user's
login-shell environment.

## Tests

`setLogSink` and `setSignpostSink` install process-wide state. `bun test` runs
files in parallel but a file's tests in sequence, so each of those files restores
the default in `afterEach` to stay independent of order.

`bounded.test.ts`'s `settled` helper flushes microtasks rather than using a timer:
every resolution in `boundedQueue` happens synchronously inside `push`, `next` or
`finish`, so two drains of the microtask queue are enough and nothing depends on
the wall clock. The `dropOldest` push loop is sequential on purpose — the claim is
that *each* push settles while the consumer is still behind, which a batched
`Promise.all` would hide.
