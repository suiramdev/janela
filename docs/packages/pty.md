# @janela/pty

Layer 3, daemon side: pseudo-terminals, child processes, the byte pump, sizing,
signal delivery and process reaping. This is **the hot path** — the part we must
be able to profile in isolation, against the budgets in
[`performance.md`](../performance.md) § Terminal throughput.

What it deliberately does not know: that sessions exist, that clients exist, that
a socket exists. It hands out bytes and takes bytes.

It is also the only package in the system permitted to import `bun:ffi`
(`scripts/layers.ts`), because giving a child a controlling terminal requires
`fork` and `login_tty`, which cannot be expressed in JavaScript. The native half
is `native/`, a small Rust cdylib.

**Effect is at this package's edges only.** `bindings.ts` opens the library once
at module load through `Effect.try`, and `spawnPseudoTerminal` is a plain
function. Nothing on the read path — `drain`, the drain buffer, the failure latch
— goes near a fiber: `architecture.md` § Effect at the seams puts the PTY reader
out of scope, and a per-frame closure per live terminal is the exact cost that
section exists to refuse.

## bindings.ts

### Locating the library

Two cases, and both matter:

- **Development.** `bun run` resolves the dylib from `native/target/release/`,
  built by `bun run build:native`.
- **The shipped sidecar.** `bun build --compile` *embeds* the dylib when it is
  imported with `{ type: "file" }`, and `dlopen` resolves it from Bun's virtual
  filesystem at runtime. Verified in the migration spike: a single compiled
  binary, run from a directory containing nothing else, spawned a real PTY. This
  is why `janelad` ships as one file rather than a binary plus a dylib, and it is
  what removed a second artifact from the signing story.

**The specifier must stay a literal.** A computed one —
`` libjanela_pty.${suffix} `` — resolves at runtime and is invisible to
`bun build --compile`, which then ships a binary with no library in it. Janela is
macOS-first; a second platform means a second literal import, which the bundler
can also see. `native-library.d.ts` declares the `*.dylib` module shape, because
TypeScript has none.

The hardened runtime still needs
`com.apple.security.cs.disable-library-validation` for the `dlopen`, which
`apps/desktop/src-tauri/Entitlements.plist` already sets so the daemon can spawn
and load the user's own unsigned tooling.

### Opening it

`native` is opened **once at module load**, not memoised on first spawn: a memo
is module-level mutable state, and a missing dylib should fail loudly at import
with a message naming the build step. Only the daemon imports this package.

`NativeLibraryUnavailable` is a `Data.TaggedError` rather than a
`PseudoTerminalFailure`, and that distinction is the point: a missing native
artifact is a build mistake, not something to show a user. It is raised by
`Effect.try` and run with `Effect.runSync` at module scope, which surfaces its
message verbatim — "@janela/pty's native library is missing. Run
`bun run build:native`." — which is what a contributor with a stale
`native/target/` needs to see.

### Marshalling

`char *const argv[]` and `envp[]` are a `BigUint64Array` of pointers into
per-string `Uint8Array`s, and **every one of those buffers must be reachable for
the duration of the call**: Bun's garbage collector does not know the native side
holds the pointers. `spawnPseudoTerminal` names them in
`reachableUntilTheChildHasExeced` and touches that local again after the call
rather than pinning them for the terminal's life. Releasing them there is
provable rather than hopeful: `jpty_spawn` returns only once the child has
exec'd — at which point the kernel has copied both vectors into the new image —
or died.

`ptr` is re-exported so this stays the only file that names `bun:ffi`.

### The error bands

The ABI carries no error type, so the native side returns biased negative
integers and the bands are disjoint by construction. Classifying them here is
therefore a lookup, not a guess about which call an errno came from.

| Constant | Value | Means |
| --- | --- | --- |
| `JPTY_EXEC_FAILED_BIAS` | 2000 | added to a **child-side** errno by `jpty_spawn`, so "couldn't open a terminal" and "couldn't start your program" are two bands |
| `JPTY_READ_FAILED_BIAS` | 3000 | added to the reader thread's errno by `jpty_read` when the descriptor itself failed, so a lost terminal (`-(3000 + errno)`) is not mistaken for a finished one (`-1`) |
| `JPTY_NO_EXIT_CODE` | `-2147483648` | what `jpty_exit_code` returns when there is no status to report |

`JPTY_BAD_HANDLE` sits *above* the read-failure band and stays on the ordinary
"nothing more" path, so a stale handle is not reported as a lost descriptor.

## size.ts

Pixels matter: without them, programs that draw images (kitty graphics, sixel)
and some TUI layout code get it wrong. `TIOCSWINSZ` carries both cells and
pixels, so we always send both.

The honest edge, unchanged by the migration: pixel metrics are a *client* fact
and the daemon is what sets the window size. Two clients on displays with
different backing scales make this genuinely ambiguous, and the protocol's
minimum-viewport rule sizes the grid in cells, not pixels.

`winsize` carries four `u16`s and `TerminalSize` carries four `number`s, so every
field is clamped into `u16` at the boundary — a client is allowed to be wrong, and
a garbage size must not become a garbage `ioctl`. `jpty_spawn` carries cells only,
which is the whole of `DEFAULT_TERMINAL_SIZE`; pixel metrics cost an extra
`resize` call, so only a client that actually has them pays for one. `SIGWINCH`'s
default action is to discard, so a child that has not exec'd yet is unaffected by
that extra call.

## byte-stream.ts

### Bytes may never be dropped

A terminal stream is stateful. Dropping bytes does not lose a line of output, it
truncates an escape sequence and desynchronises the parser — colours stick, the
cursor lands in the wrong place, the alternate screen never exits. So "shed load
when we fall behind" is not available to us.

The correct mechanism is to **stop reading**. Past the high-water mark the native
reader stops asking the PTY for more; the kernel's PTY buffer fills, and the child
blocks in `write(2)` exactly as it would against a slow physical terminal. That is
the behaviour every well-behaved CLI already handles. Reading resumes once the
backlog drains to the low-water mark. The marks themselves are budgets — see
[`performance.md`](../performance.md) § Terminal throughput — and
`TERMINAL_WATER_MARKS` in `@janela/support` is the one place they are stated.

### What changed with the runtime, and what did not

The rules did not change. Where they live did: the platform read channel and its
water marks became a dedicated OS thread inside the Rust cdylib
(`native/src/lib.rs`), because a blocking read must not occupy the JavaScript
event loop. Three rules survive verbatim:

1. **Read on a dedicated thread**, never on the runtime's own.
2. **Close the file descriptor from the thread that reads it, never from
   another.** Closing it from outside while a read is pending blocks the caller
   indefinitely on Darwin. Measured during the migration spike, and a long-known
   hazard of closing a descriptor out from under a reader. It is why
   `PseudoTerminal.close()` signals and lets the reader thread wind itself down
   rather than calling `close(2)` on the calling thread.
3. **Drain once per frame, in large chunks.** Not a compromise — the design. The
   emulator only needs bytes once per frame, and feeding it in large coalesced
   writes is what makes the sustained-throughput budget reachable at all.
   Measured: 8 KB writes sustain ~6 MB/s into the emulator, 64 KB ~32 MB/s, 1 MB
   ~140 MB/s.

### The constants

`READ_SIZE` is mirrored by `READ_SIZE` in `native/src/lib.rs`; the ABI carries no
sizes, so the two are kept in step by hand and pinned from the test side.

`DRAIN_BUFFER_SIZE` is 1 MB, derived from three measured numbers rather than
picked. The emulator's curve is flat past 1 MB, so a smaller buffer buys nothing
but lost throughput and a larger one buys nothing at all. At the rate the native
reader sustains, one `COALESCING_WINDOW_MS` frame *is* about 1 MB, so the buffer
is sized to the thing it does. And the per-live-terminal memory budget
([`performance.md`](../performance.md) § Memory) is 8 MB for everything including
scrollback, which an 8 MB drain buffer would spend on its own before the ring or a
single line of history.

`COALESCING_WINDOW_MS` is one frame at 120 Hz. It lives here so it can be tuned
against `bench/throughput.ts` rather than argued about.

### `TerminalBytes` is a view, and its lifetime is one drain

`TerminalBytes` is a `Uint8Array` view into a buffer allocated once per terminal
and reused every frame, not a copy — allocating per drain is allocating per frame
on the hot path. **The view is only valid until the next drain.** Anything that
needs to keep the bytes must copy them; the emulator does not need to. Same rule
as the frames `frameDecoder` hands out in `@janela/protocol`.

## pseudo-terminal.ts

### The spawn shape is not negotiable

**A child needs a controlling terminal, and only `fork` can give it one.**
Darwin's `posix_spawn` has no `TIOCSCTTY` file action, and `POSIX_SPAWN_SETSID`
yields a new session *without* a controlling terminal. `TIOCSCTTY` must be issued
by the child, after `setsid()`, which means it must happen between fork and exec.

Without a controlling terminal, job control breaks: Ctrl-C delivers no `SIGINT`,
`tcsetpgrp` fails, and any TUI that opens `/dev/tty` misbehaves. Every coding
agent we care about is such a TUI.

So the only correct implementation is:

```text
openpty() → fork() → [child] login_tty(replica); chdir; execve()
```

and it cannot be written in JavaScript: between `fork` and `execve` the child may
call only async-signal-safe functions, and a JavaScript runtime returning from a
foreign-function call into its own scheduler is the opposite of that. This is why
this package owns a Rust cdylib and is the only one permitted to import
`bun:ffi`.

### `argv[0]` and the login shell

`PseudoTerminalConfiguration.arguments` is the **full** argument vector,
*including* `argv[0]`. Login shells need `argv[0]` to begin with `-` (so, `-zsh`)
or they will not source the user's profile — the single most common cause of "my
PATH is wrong in this terminal app".

`executable` is an absolute path resolved by the caller. This layer does not
search `PATH`, because doing so correctly requires the user's environment, which
is a higher-level concern. `environment` is the complete environment for the
child and is **not** merged with the parent's: the caller decides exactly what the
child sees. There is no shell anywhere on this path, so there is no quoting bug
class (AGENTS.md § argv is always an array).

### Ctrl-C is a byte, not a signal

Interrupting the foreground job means **writing `CTRL_C` (`0x03`)** and letting the
tty line discipline deliver `SIGINT` to whatever process group is in the
foreground — which is what a real terminal does, and the only thing that is
correct once a shell has put a pipeline in its own process group.

`signal()` is for *teardown*, where we do mean the whole session, and it signals
the child's **process group**: signalling only the direct child leaves
grandchildren orphaned and running. `login_tty` made the child's pid its
process-group id, which is what makes that reachable. `ESRCH` — the group is
already gone — is the common case there, not an error.

`close()` hangs up: `SIGHUP` to the process group, then the reader thread winds
itself down and closes the descriptor (rule 2 above). It never blocks, never
closes the descriptor from the calling thread, and is idempotent.
`hangUpEveryPseudoTerminal()` is the daemon's `SIGTERM` path, where children must
get `SIGHUP` rather than being reparented onto launchd. It is one synchronous
native call rather than a loop in the caller: an `await` point in the middle of a
signal handler is exactly where the process dies with the sweep half done, and a
single call cannot be half done.

### Lazy by default

Nothing is allocated until `spawnPseudoTerminal`. That is what makes 40 configured
terminals viable and why `idle` is a first-class `TerminalState` in
`@janela/terminal`.

### `drain()` never throws; a lost descriptor is latched

`drain()` returns up to `DRAIN_BUFFER_SIZE` of what is buffered, as a view into
the reusable buffer. An empty view means "nothing right now"; `undefined` means
the stream has ended. When the ring holds more than a buffer's worth, a drain
takes a buffer's worth and leaves the rest — it never loops, because a frame's
cost has to stay bounded whatever one terminal is doing. Nothing is dropped: the
native reader is woken after every non-empty drain, so the backlog always makes
progress. `empty` is held rather than allocated per call, because an idle terminal
drains 120 times a second.

A descriptor that *failed* is not the same as a child that *finished*, and the
read-failure band exists to keep them apart. The failure is reported by latching
`readFailure` and returning `undefined` — a `PseudoTerminalFailure` built **once**,
never cleared, and identity-stable so any later frame reads the same object.
Plain EOF leaves `readFailure` undefined.

It is a latched field rather than a throw on purpose. `LiveTerminal.drain()` is
called once per frame for every live terminal, so a throw there is a `try`/`catch`
whose only compliant replacement is a fiber and a closure per frame per terminal
— the per-frame allocation [`performance.md`](../performance.md) § Terminal
throughput and § Rules of thumb both refuse. A throw across a per-frame boundary
also deoptimises the calling function quite apart from that. The failure is still
reported only *after* every buffered byte has been handed out, so it never hides
output, and `exitCode()` still answers on that path because the reader thread
reaps there too.

`write()` handles partial writes and `EAGAIN` natively; anything short of the full
length is a descriptor that failed, and the input was not delivered. Dropping a
keystroke silently is the one thing this layer must not do, so it raises
`NotRunning`. `resize()`, `write()` and `signal()` do throw — they are
user-initiated, not per-frame. A coalesced resize landing on a terminal that died
a frame ago is routine, and putting a dialog in front of the user for a race we
caused would be worse than ignoring it; that decision belongs to
`@janela/terminal`, which is why the raise is not suppressed here.

Resizes are extremely frequent during a live divider drag, so callers must
coalesce — [`performance.md`](../performance.md) § Interaction.

`exitCode()` reports a signal death as `128 + signo`, matching a shell. Verified
in the migration spike, including that the host runtime does not reap our children
out from under us — if it did, `TerminalState.exited(code)` would be
unimplementable.

### `PseudoTerminalFailure`

The failure set is closed, so it is modelled the way `FrameError` is in
`@janela/protocol`: one error class carrying a tagged detail, each detail a
`Data.TaggedClass` whose tag is the string the old `detail.kind` used, so log
output did not move.

| Detail class | Tag | Means |
| --- | --- | --- |
| `CouldNotAllocateTerminal` | `couldNotAllocateTerminal` | a parent-side errno: `openpty`/`fork` failed, or the child's pid never came back |
| `CouldNotStart` | `couldNotStart` | a child-side errno: `chdir` or `execve` failed, carrying the path |
| `ReadFailed` | `readFailed` | the descriptor itself failed, as distinct from EOF |
| `NotRunning` | `notRunning` | the child is gone, or we hung up |

It stays a **`UserFacingError` subclass** rather than becoming a
`Data.TaggedError`: the `instanceof` contract in `@janela/support` crosses the
daemon/client decision and `@janela/terminal` turns `summary` into a terminal's
`failed` state for every client's mirror. The tagged union is therefore the
`detail` field, **not** `reason` — `UserFacingError` already declares
`reason: string | undefined` as its presentation field, so a `reason` of any other
type does not typecheck on a subclass.

Branch on a detail with `Predicate.isTagged`, `Match.tag` or `instanceof`, never
by reading `_tag`. `pseudoTerminalFailureLabel(detail)` returns the tag as a
string for a log field. The errno rides in the detail for the log; the headline
stays one sentence.

A working directory that no longer exists is a `couldNotStart`, not a silent
fallback to somewhere else. The bug that closes is an agent running a destructive
command in the wrong tree, which is what ignoring `chdir`'s result gets you.

## Tests

`pseudo-terminal.test.ts` spawns real children on real pseudo-terminals, and
`peer-credential.test.ts` opens a real connected Unix socket pair. Neither fakes
anything, because controlling terminals, job control, `SIGWINCH`, back-pressure
and "what the kernel says about a peer" are exactly what a fake would paper over
(`testing.md` § We do not fake PTYs for PTY tests).

**Real timers are unavoidable here, and the exception is structural rather than a
preference.** The thing under test is a child process writing into a kernel PTY
buffer, read by an OS thread; there is no scheduler on this side to advance, so a
fake clock cannot produce a backlog. What is avoided is the half of the problem
that actually flakes: nothing sleeps for a guessed duration and then asserts.
Every wait is "drain until this marker appears, or fail at a deadline", and the two
real delays are *setup* for a buffer that has to fill, with assertions that do not
depend on how full it got.

That last point is measured, not assumed: how fast a child pushes bytes through a
tty varies by two orders of magnitude on one idle machine — 52 KB to 3.5 MB in the
same 250 ms window — so **no test asserts the size of a backlog**. The water marks
are pinned by value on both sides instead (`HIGH_WATER` in Rust,
`TERMINAL_WATER_MARKS.highWater` here), because asserting a backlog reached the
mark means pushing 4 MB through a tty inside a wall-clock window.

Three more details that look incidental and are not:

- The Ctrl-C test's foreground job is a loop of short sleeps rather than one long
  one. Writing the byte races the shell's own `fork`: lose the race and `SIGINT`
  reaches only the shell, which queues its trap behind whatever command it goes on
  to start. Queued behind `sleep 300` the trap fires five minutes late, which is a
  hung test; queued behind `sleep 0.1` it fires within a frame. Measured: 25
  failures in 150 runs with a single `sleep 300`, and 0 in 1000 with the loop.
- `set +m` in the grandchild tests is load-bearing: with job control off the
  background job stays in the shell's process group, which is exactly the case
  `killpg` reaches and a `kill` on the direct child does not.
- **No test may depend on the output of a child that exits immediately.** Every
  child that prints something the test then asserts on stays alive on a `read _`
  until the test writes a newline. This is Darwin, not caution: the parent closes
  the replica after `fork`, so the child's own exit closes the last replica
  descriptor, and `ttyclose` flushes the tty's queues. Anything the reader thread
  has not copied into the ring by then is gone — not buffered, not delivered late.
  Measured with `openpty` + `fork` + `/bin/echo` directly: wait 50 ms after the
  child exits and the output survives 0 times in 10, `read` returning EOF with an
  empty buffer. The reader thread is parked in `poll` and normally wins the race
  by a wide margin, which is why this reads as a rare CI-only flake — one such
  failure is what `@janela/terminal`'s exit test was built on, asserting the tail
  of `/bin/echo` rather than this layer's contract. Bytes already in the ring are
  safe: `jpty_read` drains them before it reports any stop reason.

Three checklist items are asserted in `native/src/lib.rs`'s `cargo test` module
instead, because they are only observable from the other side of the boundary:
`ws_xpixel`/`ws_ypixel` reaching the kernel, which no stock CLI reports; the
child's close-every-descriptor loop, which needs a parent deliberately holding a
descriptor without `FD_CLOEXEC`; and a read *failure*, which a real terminal
cannot produce on Darwin at all — a child exiting and `revoke(2)` on the replica
both make `read` return 0, which is EOF, measured. So the native half of that one
is proved there against a descriptor `read` rejects, and the band's mapping is
proved here against a scripted `NativePtyLibrary`.

`bench/throughput.ts` is run by hand (`bun run bench`) and is deliberately **not**
a test: a three-second flood inside a parallel `bun test` run measures the
machine's load rather than this code. Four numbers, each guarding a different
failure — MB/s off the PTY (the budget), worst timer lag (a blocking call on the
JavaScript thread shows up there first), neighbour responsiveness, and the RSS
plateau with nobody draining, which is the difference between real back-pressure
and an unbounded buffer. Until a benchmark harness lands the numbers belong in the
pull request (`testing.md` § Performance tests).

## peer-credential.ts

### Why this is in the PTY package

It has nothing to do with a pseudo-terminal, and it is here anyway: `bun:ffi` is
gated to this package and Bun exposes no peer-credential accessor, so the
alternative is a second native artifact to build, sign and locate. Without this
reader `verifyPeer` refuses every peer as `credential-unavailable` and no client
can connect at all.

### It does not decide anything

The bytes go up exactly as the kernel wrote them, and `@janela/daemon`'s
`verifyPeer` checks the version, the length and the uid — one authorization rule,
in the language its tests are written in. Nothing here widens, pads or interprets
a field.

`XUCRED_LENGTH` is `sizeof(struct xucred)` on macOS, measured at 76 bytes on
macOS 26. `@janela/pty` may not import `@janela/daemon` — that edge points
sideways — so this duplicates `XUCRED_BYTE_LENGTH` there. The pair is kept in step
by hand, and a drift is visible rather than silent: this side allocates the buffer
and reports the length the kernel filled, so a mismatch surfaces as
`credential-truncated` rather than as a misread field. Both sides pin the number
in their own tests.

`xucred` is **trimmed to the length the kernel reported, never padded**: a short
fill must stay visible, because that is the only signal that the struct's fields
do not mean what we think. It is a view, not a copy — `verifyPeer` reads four
fields and keeps nothing.

`readPeerCredential` never throws for a socket the kernel refuses to answer for. A
closed or non-socket descriptor produces `{ xucred: undefined }`, which
`verifyPeer` refuses: fail-closed, and the caller needs no `try`. `pid` is a log
field only, and is `undefined` when the kernel would not say.

`RawPeerCredentialBytes` is structurally identical to `RawPeerCredential` in
`@janela/daemon`, which is what `socketListener` takes — the composition root
passes this straight through.

The test reads the descriptor behind a Bun socket by **decoding** it with a
`Schema.Struct({ fd: Schema.Number })`, because `fd` is a real property on Bun's
socket and is missing from its type declarations. A decode failure names the cause
— a Bun upgrade removed `fd` — instead of surfacing later as a mysterious
`credential-unavailable`. `Bun.listen`/`Bun.connect` rather than `node:net`: that
module is gated to `@janela/daemon` by `scripts/layers.ts`, and the gate scans
test files too.
