# 0020. Bun is the daemon's runtime, shipped as one compiled binary

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** the Swift 6 concurrency model in
  [0003](0003-concurrency-model.md). The isolation *rules* survive; the language
  that checked them does not.

## Context

[0015](0015-daemon-owned-sessions.md) makes `janelad` the process that owns
everything durable: PTYs, the headless emulator, git, the database, automation, and
the socket. It is the part of Janela that must not crash, must not leak, and must
sustain ~100 MB/s of terminal output without the machine noticing. Choosing what it
runs on is therefore the load-bearing decision of this migration, more than the
client's shell is.

Three requirements, all from documents that predate the migration:

1. **It must survive the app closing**, which means it is a long-lived background
   process the user did not consciously start ([0015](0015-daemon-owned-sessions.md)).
2. **It must meet the budgets in [`../performance.md`](../performance.md)**:
   ≥100 MB/s sustained PTY throughput, bounded memory under a flood, and one
   flooding terminal having no measurable effect on its neighbours.
3. **It must ship inside the app bundle as a signed, notarized executable**
   ([0008](0008-sandboxing-and-distribution.md), [0017](0017-daemon-lifecycle.md)),
   which means the fewer loose files it needs beside it, the better.

[0003](0003-concurrency-model.md) chose Swift 6 strict concurrency and got
compile-time data-race safety for it. That is a real thing to give up and this ADR
should not pretend otherwise. What it bought, though, was mostly protection against
a hazard that a single-threaded runtime does not have: the daemon's shared mutable
state is a session registry and a connection table, and 0003's own answer for those
was "make them actors" — which is to say, serialise access to them. A single-threaded
event loop serialises access to everything, for free, by construction.

The hazard that *replaces* it is different and worth naming up front: **blocking the
event loop**. In Swift, a blocking read on the wrong thread was a performance bug. In
a single-threaded runtime it is a liveness bug that stalls every terminal at once.

## Decision

**`janelad` is a Bun process, shipped as a single binary produced by
`bun build --compile`.**

### Why Bun rather than Node

- **`bun build --compile` produces one self-contained executable.** Runtime,
  application code, the Prisma client, the emulator, and the PTY's native library
  are all embedded. Verified during the migration: the compiled binary was copied to
  an otherwise empty directory and spawned a real PTY, drove a real emulator, and
  ran real database queries. That property is what keeps
  [0008](0008-sandboxing-and-distribution.md)'s signing story at two binaries in the
  bundle rather than a binary plus a scatter of addons and `node_modules`.
- **`bun:sqlite` is built in**, which is what makes the database work in a compiled
  binary at all ([0019](0019-prisma-sql-layer.md)).
- **`bun:ffi` is a first-class, low-overhead FFI**, which is what makes the PTY
  layer possible without a native module system ([0021](0021-pty-native-layer.md)).
- One toolchain for the daemon, the client and the tooling, which for a project of
  this size is worth more than any individual feature.

### The rules that replace strict concurrency

0003's isolation rules were about *where work happens*. They survive, restated for a
single-threaded runtime, and they are not style preferences:

- **Never block the event loop.** Every blocking read lives on a thread inside the
  PTY's native library, and reaches JavaScript as a buffer to drain. A blocking call
  in the daemon's own code stalls every terminal simultaneously.
- **The read path never allocates per byte, and drains once per frame.** Unchanged
  in intent from 0003, and now measured: feeding the emulator in 8 KB chunks
  sustains ~6 MB/s, in 1 MB chunks ~140 MB/s. The coalescing is not an optimisation,
  it is how the budget is met ([0018](0018-terminal-engine.md)).
- **Back-pressure by not reading.** Past the high-water mark the native reader stops
  reading; the kernel PTY buffer fills and the child blocks in `write(2)`. Bytes are
  never dropped, because a dropped byte truncates an escape sequence and
  desynchronises the parser. Verified: with the consumer stopped entirely, resident
  memory grew ~4 MB and then stopped.
- **Per-client output queues are bounded, and coalesced repaints may drop their
  oldest entry — terminal input may not.** Same distinction 0003 drew, same reason.
- **Values crossing the socket are plain and immutable.** 0003 got this from
  `Sendable`; here it is a convention with a linter behind the easy half. This is
  the one place the compile-time guarantee is genuinely gone and honesty requires
  saying so.

### Measured against the budgets

From the migration spikes, on an M-series Mac:

| Property | Budget | Measured |
| --- | --- | --- |
| Sustained PTY throughput | ≥ 100 MB/s | **133 MB/s** under a `yes` flood |
| Memory growth with the consumer stalled | bounded | **~4 MB**, then flat |
| Event-loop responsiveness during a flood | not stated | worst timer lag **1.7 ms** |
| A second terminal during the flood | no measurable effect | **stayed interactive** |

The event-loop figure is the one that mattered most, because it is the property the
single-threaded model puts at risk. Under a 133 MB/s flood, an 8 ms timer fired
within 1.7 ms of its deadline, and a second terminal echoed a command normally.

## Consequences

**Good.** One binary. No `node_modules` beside it, no addons to locate, sign or
notarize separately, and no possibility of a partially-installed daemon.

**Good.** The whole session lifecycle is exercisable in-process with no window
server, which 0015 already noted is a far better test surface than a UI-hosted
store. That improves further here: the daemon's tests are ordinary `bun test` files.

**Good.** Startup is fast enough that socket activation stays viable — the cold-daemon
budget in `../performance.md` exists because a user's first connection pays it.

**Bad — and this is the one to be honest about.** Compile-time data-race safety is
gone. 0003's central claim was "data races are compile-time errors", and that is no
longer true; the replacement is a runtime with one thread, which prevents the same
class of bug by a weaker but real mechanism, plus review for the parts it does not
cover. Anything genuinely concurrent lives in the PTY's native library, where Rust
checks it.

**Bad.** A blocking call anywhere in daemon code stalls every terminal at once,
where previously it would have stalled one queue. The failure is more global and
less obvious, and the mitigation is a rule rather than a checker.

**Bad.** ~69 MB per binary, essentially all runtime. See
[0019](0019-prisma-sql-layer.md) § Consequences.

**Bad.** Bun is young relative to what it is being asked to do here — hold a user's
work for hours in a background process. It is the newest load-bearing dependency in
the system. Mitigations: the daemon's own code is small, the risky parts are pushed
into Rust, and the protocol boundary means a rewrite of the daemon would not touch
any client.

**Bad.** GC pauses are now a thing that can affect terminal latency, where ARC was
predictable. Nothing measured suggests it matters at this scale, but the failure
mode is new and unmeasured under a day-long session.

## Alternatives considered

**Node.** More mature, more widely deployed, and the safer institutional choice.
Rejected on packaging: SEA is markedly less capable than `bun build --compile`, and
`better-sqlite3` — the natural SQLite binding — is a native addon that must be
shipped and located beside the binary. It would also lose `bun:ffi`, so the PTY
layer would need a node-gyp addon instead, which is a heavier build for every
contributor and every CI run. Reconsider if Bun's stability becomes a real problem;
the daemon's code would largely port.

**Keep the daemon in Swift, migrate only the client.** Genuinely worth considering:
it preserves 0003 entirely, keeps the hot path in a compiled language, and the
daemon has no UI to make portable. Rejected because it would leave two languages,
two toolchains and two test runners in a project this size, and — more decisively —
`@janela/core` and `@janela/protocol` are *shared* by both processes. Keeping the
daemon in Swift means maintaining the domain model and the wire protocol twice, in
two languages, in agreement. That is precisely the duplication the single-package
graph exists to prevent, and every schema change would pay it.

**Rust for the whole daemon.** Best performance ceiling, real compile-time
guarantees, and the PTY layer is already Rust. Rejected as disproportionate: the
daemon is mostly lifecycle logic, git invocations and message routing, none of which
is performance-critical, and all of which is faster to write and change in
TypeScript. The parts that genuinely need Rust are already in Rust, which is the
right split.

**Go.** A strong fit for a long-lived daemon and excellent at single static binaries.
Rejected for the same reason as Swift: it does not share a language with the client,
so `@janela/core` and `@janela/protocol` would exist twice.

## Revisit when

- A GC pause or an event-loop stall shows up in a real session as terminal latency.
  The first response is to move more of the drain path into the native library, not
  to change runtimes.
- Bun ships a breaking change that the daemon cannot absorb, or a stability problem
  costs a user their work. That is the signal to reconsider Node, and the port is
  mostly mechanical.
- The daemon grows genuinely parallel work that a single thread cannot serve. There
  is no such work today, and adding some would be an architecture change worth its
  own ADR.
