# 0018. xterm.js on both sides, behind the two existing seams

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** [0004](0004-terminal-engine.md)

## Context

[0004](0004-terminal-engine.md) chose SwiftTerm behind two protocols and named
libghostty-vt as the planned v2 evaluation. The migration to a TypeScript stack
([0020](0020-bun-daemon-runtime.md), [0023](0023-macos-first-portable.md)) removes
SwiftTerm as an option, so the engine has to be decided again. What does *not* need
deciding again is the shape, and that is the important half.

0004's structure survives intact, because it was never about Swift:

- **Interpreting bytes into a screen**, in the daemon, headless. No fonts, no
  drawing — a state machine and a grid.
- **Drawing a screen**, in each client. No PTY, no child process: it receives
  escape sequences over a socket exactly as a real terminal receives them from a
  pty, and paints.

0004 also noted, in its own alternatives, that "xterm.js in a WKWebView" was
rejected for one reason: *"The only reason to choose this is reuse from an existing
web IDE, and Janela has none. It would also contradict the native premise
outright."* The second half of that sentence is what changed. The client is a
WebView now, deliberately and with its costs written down. The first half was
always the weaker argument.

One thing 0004 could not have known is measurable now. The daemon's emulator has a
throughput budget — ≥100 MB/s sustained, from
[`../performance.md`](../performance.md) — and whether a JavaScript VT parser can
meet it was the open question. Measured against `@xterm/headless` 6.0 on an M-series
Mac, feeding a plain-text flood:

| Write size    | Sustained    |
| ------------- | ------------ |
| 8 KB chunks   | ~6 MB/s      |
| 64 KB chunks  | ~32 MB/s     |
| 1 MB chunks   | ~140 MB/s    |

That is a striking spread, and it is the real finding: **the budget is met by how
the emulator is fed, not only by what implements it.** Per-read feeding fails it by
a factor of fifteen; the once-per-frame coalescing that
[0003](0003-concurrency-model.md) already required passes it comfortably. An
escape-sequence-heavy payload — a full-screen TUI redrawing every cell with colour
— sustained ~10 MB/s, which is ~776 complete 120×40 repaints per second, far past
what any client renders.

The other open question was `serialise-for-attach`, which 0004 called out as "the
piece SwiftTerm does not give us" and 0015 called the hard part. `@xterm/addon-serialize`
provides it. Verified by writing coloured, cursor-positioned content into a headless
terminal, serialising, replaying into a second, and comparing buffers cell by cell:
identical, in 143 bytes for content spanning five rows. Repeated for a 100×30
alternate-screen TUI with the cursor left mid-screen: identical, 1802 bytes, cursor
position and buffer type preserved.

## Decision

**`@xterm/headless` in the daemon, `@xterm/xterm` in the client, reached only
through the two protocols 0004 established.**

| Seam                | Package               | Backed by                                | Owns                                                        |
| ------------------- | --------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `TerminalEmulating` | `@janela/terminal`    | `@xterm/headless` + `@xterm/addon-serialize` | Authoritative grid, scrollback, damage, text snapshots |
| `TerminalRendering` | `@janela/terminal-ui` | `@xterm/xterm`                           | Painting, fonts, selection, keyboard input                   |

Nothing outside those two packages may import a terminal library. The rule is
unchanged from 0004; what changed is that it is now *enforced* rather than reviewed,
because a package manifest no longer does it for us — see
[0022](0022-layering-enforcement.md) and the gated-module table in
`scripts/layers.ts`.

Two consequences of the stack that are worth stating as rules rather than leaving
implicit:

- **Feed the emulator once per frame, in whole coalesced chunks.** This is a
  correctness-adjacent performance rule, not a tuning knob; the measurements above
  are why. It is recorded in `@janela/pty`'s `byte-stream.ts` next to the code that
  must obey it.
- **A correct-but-dumb full repaint every frame is always a valid fallback** for
  damage-encoded repaint. That was true in 0015 and stays true: it means the hard
  optimisation can make us slow, never wrong.

## Consequences

**Good.** The two-seams rule survives a total change of language, which is the best
evidence available that it was a real boundary rather than a Swift artefact.

**Good.** Pure JavaScript on the hot path. No FFI, no native build step, no second
artifact to sign and notarize, and it survives `bun build --compile` — which
matters more than it sounds, because that constraint is exactly what disqualified a
database driver during this same migration ([0019](0019-prisma-sql-layer.md)). The
migration already absorbs a Rust cdylib for the PTY, Tauri's Rust shell, and
Prisma's WASM query compiler; the hottest path in the system is a good place to stop
adding native risk.

**Good.** The repaint encoder is testable the obvious way, and 0004's suggested test
works verbatim: feed bytes to one emulator, encode, feed the result to a second,
assert the grids match. That test was written against SwiftTerm on paper and now
runs against xterm.js in fact.

**Bad — and this is the real cost.** 0004's "two seams, one library, one rule" is
gone. The daemon and the client now run *different* libraries from the same family,
so an emulator bug no longer reproduces identically on both sides, and a
divergence between what the daemon believes is on screen and what the client draws
is newly possible. The protocol makes this survivable — it ships escape sequences,
so the two sides need only agree on VT semantics, not on an internal grid format —
but "they cannot disagree because they are the same code" has become "they should
not disagree", which is a weaker guarantee held by convention. Mitigation: the
round-trip test above uses the daemon's emulator on one end, and a variant using
the client's renderer on the other end is worth writing before v1.

**Bad.** We inherit xterm.js's open correctness issues, notably around reflow —
which, as 0004 noted, is an interactive path here rather than a window-resize edge
case, because dragging a split resizes its neighbour. Unchanged in substance from
the SwiftTerm risk it replaces.

**Bad.** The daemon's emulator is now a JavaScript object graph rather than a
native one, so the memory floor per terminal is higher and scrollback is bounded in
a garbage-collected heap. `DEFAULT_SCROLLBACK` is where that bound lives, and
non-negotiable #9 is why it exists.

**Neutral, worth writing down.** Retina pixel metrics (`ws_xpixel`/`ws_ypixel`)
remain a *client* fact set by the daemon, and mixed-DPI clients attached to one
terminal remain a known open edge. Identical to 0004; the migration neither fixed
nor worsened it.

## Alternatives considered

**A native VT library behind `bun:ffi`.** The PTY already ships a Rust cdylib
([0021](0021-pty-native-layer.md)), so a VT crate could share that boundary and that
artifact. Rejected for v1 on two grounds. First, the measurements above say the
throughput budget is already met, so this would buy headroom we have no evidence of
needing — and the thing that actually governs throughput is the feed pattern, which
a native parser would not change. Second, only one of the three capabilities the
design needs is a library feature at all: per-cell damage tracking and
minimal-sequence repaint encoding are ours to write either way, and
serialise-for-attach is the one an emulator library hands us. Taking on a native
dependency to get one of three, on the path where a fault takes down every terminal
the user has running, is the wrong trade at this stage. This is the option to
revisit if the trigger below fires.

**Write our own.** Rejected for the same reason 0004 rejected it, and the reason did
not get smaller: the `ctlseqs` surface is enormous, the reference documentation
contradicts itself, and it is not where Janela's value is. See
[`../product.md`](../product.md) § Non-goals — we do not replace the user's tools,
and that includes their terminal's guts.

**The emulator in Tauri's Rust shell.** Superficially attractive: Rust is already
there, and it would put the parser in a native process. Architecturally excluded,
not merely worse. The emulator must live where the PTYs live, or terminals stop
surviving the app closing — which is a product guarantee
([0015](0015-daemon-owned-sessions.md)), not an implementation preference. Stated
explicitly because it is the obvious-looking idea a future reader will propose.

**One library, on the daemon side only, shipping a grid to clients.** Would restore
0004's single-library property. Rejected because it discards the reason the protocol
ships escape sequences at all: every client already knows how to consume them, and a
grid format is one every client would have to learn. See 0015's terminal data flow.

## Revisit when

- **A measurement, not an announcement.** If the emulator falls short of the
  throughput budget in `../performance.md` under a `yes` flood or a full-screen TUI
  repaint — measured, with the once-per-frame feed pattern in place — that is the
  signal. The first move is a native VT parser behind the PTY's existing cdylib and
  FFI boundary, so it costs one more export rather than a second native artifact.
- The daemon/client engine divergence produces a real rendering bug. That is the
  moment to decide whether "one library on both sides" is worth reaching for again,
  and what it would now cost.
- `@xterm/addon-serialize` stops being maintained. The attach path depends on it
  entirely. It is small, MIT-licensed and vendorable, which is the mitigation — the
  same posture 0004 took toward SwiftTerm's single-maintainer risk.
