# 0003. Swift 6 strict concurrency, main-actor UI, off-main PTY

- **Status:** Superseded by [0020](0020-bun-daemon-runtime.md)
- **Date:** 2026-08-12

> Swift 6 strict concurrency is gone with the language. The *isolation rules* survive
> almost verbatim in [0020](0020-bun-daemon-runtime.md) — never block the read path,
> coalesce once per frame, back-pressure by not reading, never drop a byte, bound
> every queue — and the measurements in this ADR are still the reason for them. What
> is genuinely lost is compile-time data-race checking; 0020 says so plainly rather
> than claiming an equivalent.
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — the read path
  moved into the daemon and a socket now sits between it and the UI. The isolation
  rules are unchanged; where they apply is.

## Context

Janela's defining workload is many concurrent PTY streams feeding a UI. A single
`yes` or a verbose build can produce hundreds of MB/s. The naive shape — read a
chunk, hop to `@MainActor`, feed the emulator, redraw — collapses under that load,
and it collapses in a way that makes the *whole app* unresponsive rather than just
the offending tab.

Measured behaviour from SwiftTerm's own source, which has solved this already
(see [`../research/terminal-stack.md`](../research/terminal-stack.md) § 5.4):
without a high-water mark, a `yes` flood against a busy main thread produced
~280 MB/s of accumulation and multi-GB memory footprints in long sessions.

Meanwhile, the client-side `SessionStore` and `ProjectStore` exist to drive views.
Making them actors would mean `await`ing to read a tab title.

Since [0015](0015-daemon-owned-sessions.md) the workload spans two processes, which
*helps*: the flood is absorbed where there is no UI to starve, and the socket
carries frame-rate-bounded repaints rather than raw output. The hard problem did not
go away, it moved into `janelad`, where it is easier to reason about because nothing
there has to stay responsive to a human.

## Decision

Swift 6 language mode with complete strict concurrency in every target. Then:

- **UI-facing state is `@MainActor`.** In the *client*: `SessionStore`,
  `ProjectStore`, `TerminalMirror` and `AppEnvironment` are main-actor `@Observable`
  classes fed by the connection.
- **`PseudoTerminal` is an `actor`** owning the controller fd and child process.
- **The read path never hops per chunk**, and it is now entirely inside the daemon,
  where there is no main actor at all. A dedicated `DispatchIO` channel per terminal
  reads on a private queue and feeds that terminal's emulator on a per-terminal
  serial queue. The unit is the *terminal*, not the session: a session with four
  splits is four independent read paths, and one flooding pane must not affect its
  neighbours.
- **The daemon has no main actor.** `janelad` is a server: its work is per-terminal
  and per-connection, with no shared UI thread to protect. Global daemon state — the
  session registry, the connection table — is an actor; terminals own their own
  queues. A `@MainActor` annotation in daemon-only code is a mistake, not a style
  choice.
- **Socket writes are coalesced once per frame, per attached client.** Damage
  accumulates in the emulator and is encoded on a timer, so a client that stops
  reading applies back-pressure to *its own* stream and nothing else. A slow phone
  must not slow down the Mac's window.
- **Back-pressure by not reading.** Past the high-water mark we stop re-arming the
  read so the kernel PTY buffer fills and the child blocks in `write(2)`. We never
  drop bytes — see [0004](0004-terminal-engine.md) and `ByteStream.swift`.
- **Value types are `Sendable`.** Everything in `JanelaCore` is a `Sendable`
  struct or enum, so crossing isolation domains is free and checked.
- **Off-main work is `Sendable` and injected.** `JanelaGit`, `JanelaForge` and
  `JanelaPersistence` now run in the daemon and are called with `await` from its
  actors. Forge refreshes in particular are network-bound and must never be awaited
  on a path a client is waiting for — see [0012](0012-forge-integration.md).
- **Nothing in the client blocks on the daemon.** Every request is `async`, and every
  view renders from the last known mirror — including when the connection is down.
  "Waiting for the daemon" is a state to render, never a thread to block.

Practical rule for contributors: **if a type exists to be displayed, it is
`@MainActor`; if it exists to do work, it is an actor or a `Sendable` value.**

## Consequences

**Good.** Data races are compile-time errors. The hot path is isolated in
`JanelaPTY`, which has no UI and no third-party dependencies, so it can be
profiled and stress-tested alone. Views read state synchronously.

**Bad.** SwiftTerm compiles in **Swift 5 language mode**
(`swiftLanguageModes: [.v5]` in its `Package.swift` —
[`../research/apple-platform-2.md`](../research/apple-platform-2.md) § 2.5), so its
types carry no `Sendable`/`@MainActor` annotations and its delegate protocols are
plain `AnyObject`. Conforming to them from our Swift 6 modules will require
`@preconcurrency import SwiftTerm` and/or `MainActor.assumeIsolated` at each
callback. This containment is one more reason the emulator sits behind a protocol.

**Bad.** `DispatchIO` and Swift concurrency are two different worlds, and the
bridge between them is hand-written rather than idiomatic. It is confined to
`TerminalByteStream` — and now also to the socket transport, which has the same
shape and must reuse the same discipline rather than inventing a second one.

**Bad.** State can now be *stale* rather than merely contended, and that is a failure
mode strict concurrency cannot check for us. A client's mirror is always slightly
behind the daemon, and every view has to be correct when it is. Compile-time safety
does not extend across a socket; only tests do.

## Alternatives considered

**`AsyncStream` over `FileHandle.readabilityHandler`.** Simple and wrong: it
delivers on an arbitrary queue with no back-pressure and allocates a `Data` per
callback.

**Everything on the main actor.** Simplest possible model, and viable for one
idle terminal. Rejected on the throughput evidence above.

**Actors for UI state.** More "correct" isolation, but it makes every view read
asynchronous, which SwiftUI handles badly and which buys nothing: view state is
touched from the main thread anyway.

## Revisit when

- SwiftTerm adopts Swift 6 language mode — the `@preconcurrency` shims can go.
- Profiling shows the `DispatchData` → `[UInt8]` copy dominating; the documented
  next step is `DispatchSource.makeReadSource` with a reusable buffer.
