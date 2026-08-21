# 0021. The PTY is a Rust library behind `bun:ffi`

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

`@janela/pty` is the hot path and the part of Janela that must be correct under
conditions nothing else faces: 100 MB/s of output, a child that expects a real
terminal, and a teardown that must not orphan processes. [0020](0020-bun-daemon-runtime.md)
puts the daemon on Bun, which raises the question this ADR answers: how does a
JavaScript runtime give a child process a controlling terminal?

It cannot, and the reason is specific rather than incidental.

**A child needs a controlling terminal or job control breaks.** Ctrl-C delivers no
`SIGINT`, `tcsetpgrp` fails, and any program that opens `/dev/tty` misbehaves. Every
coding agent Janela exists to host is a full-screen TUI that needs all of it. On
Darwin, `TIOCSCTTY` must be issued *by the child*, after `setsid()`, which means
between `fork` and `execve`. In that window the child may call only
async-signal-safe functions — and a JavaScript runtime returning from a foreign call
into its own scheduler and allocator is the opposite of that. So the entire
`openpty → fork → login_tty → execve` sequence has to be one native call.

The Swift design reached the same conclusion from the same constraint; the note in
`PseudoTerminal.swift` said `posix_spawn` cannot do it and only `fork` can. Nothing
about that changed with the language.

The mature JavaScript option was evaluated properly rather than dismissed:

**`node-pty`**, which VS Code ships and which is the first thing any reader will
ask about. Two findings, both measured. Its prebuilt `spawn-helper` ships **without
the executable bit** under both `bun add` and `npm install`, which fails as a
misleading `posix_spawnp failed` until you `chmod +x` it. After fixing that, spawning
worked but reading did not: its `onData` delivered nothing under Bun, and reading its
file descriptor directly returned `EBADF`. It is built against Node's stream and
addon internals, and Bun's compatibility layer does not reach far enough.

**`bun-pty`**, a Rust-and-FFI package built for Bun. It works — a shell spawned, a
command echoed, `tty` reported a real `/dev/ttys*`. But it is unusable for this
specific job: it joins argv into a string and re-splits it with `shell_words` on the
Rust side, which reintroduces exactly the quoting bug class every other layer of
Janela is built to avoid; its API is `string`-only, so arbitrary bytes cannot pass
through intact; and it polls 4 KB reads on a timer with no water marks, which is
neither the throughput nor the back-pressure the budgets require.

Neither can satisfy non-negotiables #8 and #9, which make read-side back-pressure
and bounded buffers product law rather than tuning.

## Decision

**`@janela/pty` owns a small Rust `cdylib`, called through `bun:ffi`. It is the only
FFI surface in Janela**, enforced by [0022](0022-layering-enforcement.md).

The native side owns exactly four things, and nothing else:

1. **The spawn sequence.** `openpty` → `fork` → `login_tty` → `chdir` → reset signal
   dispositions → `execve`. argv and envp are `char *const[]` arrays built on the
   JavaScript side and passed through untouched — nothing parses a command line
   anywhere in this path.
2. **A reader thread per terminal**, doing blocking reads into a ring buffer with
   high and low water marks. Past the high mark it stops reading, the kernel PTY
   buffer fills, and the child blocks in `write(2)`. Bytes are never dropped.
3. **`TIOCSWINSZ` and `killpg`.** Resize with pixel metrics, and signals to the
   process *group*, because signalling only the direct child orphans grandchildren.
4. **Reaping**, so an exit status is available — including signal deaths as
   `128 + signo`.

JavaScript drains the ring once per frame in one large call, which is both what the
emulator wants ([0018](0018-terminal-engine.md)) and what keeps FFI overhead
irrelevant: ~125 calls per second regardless of throughput.

### The rule that cost the most to learn

**The file descriptor is closed by the thread that reads it, never by another.**
Closing it from outside while a read is pending blocks the closing thread
indefinitely on Darwin — measured during the migration, as a test that hung rather
than failed. Teardown therefore sends `SIGHUP` to the process group and lets the
reader thread wind itself down and close. `close()` returns in well under a
millisecond and never blocks.

This is the same hazard the Swift notes recorded from SwiftTerm's source, arrived at
independently and the hard way.

### Packaging

The library is built by `cargo build --release` and imported with
`{ type: "file" }`, which makes `bun build --compile` **embed it in the binary**;
`dlopen` then resolves it from Bun's virtual filesystem at runtime. Verified: the
compiled daemon, copied to an empty directory, spawned a real PTY. So the daemon
ships as **one file**, not a binary plus a dylib, and
[0008](0008-sandboxing-and-distribution.md)'s two-binaries-in-a-bundle story is
unchanged. The hardened runtime already carries
`com.apple.security.cs.disable-library-validation` — needed anyway so the daemon can
spawn the user's own unsigned tooling — which covers the `dlopen`.

Cargo is already required by Tauri ([0023](0023-macos-first-portable.md)), so this
adds no toolchain a contributor did not already need.

### Verified behaviour

Everything below was run against the spike before this was decided, not asserted
after:

| Property | Result |
| --- | --- |
| Controlling terminal | `tty` reports `/dev/ttys*`; login shell sources the user's profile |
| `TIOCSWINSZ` + `SIGWINCH` | `tput cols`/`lines` reflect a resize immediately |
| Full-screen TUI | `vim` enters and leaves the alternate screen and edits a real file |
| Ctrl-C | writing `0x03` interrupts the foreground job through the line discipline |
| Exit codes | `0`, `7`, and `143` for a `SIGTERM` death, all reported correctly |
| Teardown | `SIGHUP` to the group kills grandchildren; `close()` returns in 0.4 ms |
| Throughput | 133 MB/s sustained under `yes`, bounded memory, neighbours unaffected |

## Consequences

**Good.** The one part of the system that must be correct under load is written in a
language that checks memory and thread safety, and it is small enough to read in one
sitting.

**Good.** argv is an array end to end, so the quoting bug class does not exist on
this path — matching `LaunchProfile.command` and `AutomationCommand.command`.

**Good.** Back-pressure is real rather than aspirational, and it is enforced where
the reading happens rather than several layers up.

**Bad.** A native build step. Contributors need a Rust toolchain, CI needs a cargo
job, and a stale `target/` produces confusing failures. Mitigated by Tauri needing
cargo anyway, and by `bun run bootstrap` building it.

**Bad.** `bun:ffi` marshalling is manual and unforgiving. The argv/envp pointer
arrays must be kept alive across the call — Bun's garbage collector does not know the
native side holds them — and getting that wrong produces a crash that looks like a
Rust bug. It is confined to one file and documented there.

**Bad.** A panic in the library unwinds into the JavaScript runtime, which is
undefined behaviour. The release profile sets `panic = "abort"` so it is a clean
crash instead, and launchd restarts the daemon. A fault here still takes every
terminal the user has running, which raises the bar on testing this package
specifically.

**Bad.** Cross-compiling for a second architecture means building the library for it
too. Only relevant when universal binaries matter.

## Alternatives considered

**`node-pty`.** The mature choice, and what VS Code uses. Rejected on measurement:
it does not work under Bun (reads returned nothing; the fd was `EBADF`), and its
prebuilt helper ships without the executable bit. Recorded in detail above because
"why not node-pty" is the first question any reader will have.

**`bun-pty`.** Purpose-built for this runtime and it does work. Rejected on three
specifics: argv round-trips through `shell_words` string splitting, the API is
string-only so arbitrary bytes cannot survive, and 4 KB polled reads with no water
marks meet neither the throughput budget nor non-negotiable #9. Worth revisiting if
it grows a byte-oriented API with real back-pressure.

**A Node-API addon instead of `bun:ffi`.** More portable across runtimes and better
GC integration. Rejected: it needs node-gyp on every contributor machine, and it
would not survive `bun build --compile`, which is precisely what disqualified the
libsql adapter in [0019](0019-prisma-sql-layer.md).

**Put the PTY in Tauri's Rust shell.** Rust is already there. Architecturally
excluded: PTYs must live in the daemon or terminals stop surviving the app closing,
which is a product guarantee ([0015](0015-daemon-owned-sessions.md)). Stated because
it is the obvious-looking idea.

**Shell out to a helper binary that owns the PTY.** No FFI, and process isolation
for the riskiest code. Rejected: it moves the bytes through a pipe, which is another
copy on the hottest path, and it replaces one FFI boundary with a process lifecycle
to manage per terminal.

## Revisit when

- Bun grows a built-in PTY API. That would delete this library and this ADR, and it
  is the outcome to hope for.
- `bun:ffi` marshalling causes a crash we cannot diagnose, at which point a Node-API
  addon is the fallback — with the compile-embedding problem to solve.
- A second FFI need appears. It should go through *this* library rather than opening
  a second surface; `launch_activate_socket` for socket activation
  ([0017](0017-daemon-lifecycle.md)) is the known candidate, and it is one export.
