# 0003. Swift 6 strict concurrency, main-actor UI, off-main PTY

- **Status:** Accepted
- **Date:** 2026-08-12

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

Meanwhile, `TerminalSession`, `SessionRegistry` and `WorkspaceStore` exist to drive
views. Making them actors would mean `await`ing to read a tab title.

## Decision

Swift 6 language mode with complete strict concurrency in every target. Then:

- **UI-facing state is `@MainActor`.** `TerminalSession`, `SessionRegistry`,
  `WorkspaceStore`, `AppEnvironment` are main-actor `@Observable` classes.
- **`PseudoTerminal` is an `actor`** owning the controller fd and child process.
- **The read path never hops per chunk.** A dedicated `DispatchIO` channel per
  session reads on a private queue; parsing happens on a per-session serial queue,
  *not* the main queue; we cross to the main actor at most once per frame to mark
  dirty regions.
- **Back-pressure by not reading.** Past the high-water mark we stop re-arming the
  read so the kernel PTY buffer fills and the child blocks in `write(2)`. We never
  drop bytes — see [0004](0004-terminal-engine.md) and `ByteStream.swift`.
- **Value types are `Sendable`.** Everything in `JanelaCore` is a `Sendable`
  struct or enum, so crossing isolation domains is free and checked.

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
`TerminalByteStream`.

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
