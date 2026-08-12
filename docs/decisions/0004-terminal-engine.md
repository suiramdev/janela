# 0004. SwiftTerm behind a protocol; libghostty as the v2 option

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

The terminal is the product. Its emulator must handle the full xterm sequence set,
scrollback, reflow, mouse reporting, bracketed paste, and the alternate screen,
because every coding agent we intend to host is a full-screen TUI that uses all of
it.

Building this ourselves is not a weekend. The `ctlseqs` surface is enormous, and
the reference documentation openly contradicts itself in places — DEC's own manuals
disagree on `DECSDM`/`CSI ? 80 h`, and DEC STD 070 is more than twice the length of
the VT520 programmer's reference
([`../research/terminal-stack.md`](../research/terminal-stack.md) § 4).

The realistic options, from primary-source review:

| Option | Time to usable | Ceiling | Maintenance risk |
| --- | --- | --- | --- |
| SwiftTerm | Days | Good | Medium — MIT, active, effectively one maintainer, Swift 5 mode |
| libghostty-vt | Weeks | Excellent | Medium-high — API churn, Zig build step |
| Own VT + Metal | Months | Excellent | Very high |
| xterm.js in WKWebView | Days | Poor | Medium |

Notably, **cmux — the one native macOS project in our prior art — uses libghostty**
via a `GhosttyKit.xcframework` built from a vendored Ghostty submodule
([`../research/prior-art-2.md`](../research/prior-art-2.md) § 1.1). And libghostty
now ships an official Swift XCFramework example
([`../research/terminal-stack-2.md`](../research/terminal-stack-2.md) § 8), so it is
a genuinely available option rather than a theoretical one. Its own header,
however, still warns: *"the API is not yet stable. Breaking changes are expected…
Use with caution in production code."*

## Decision

Ship **SwiftTerm**, reached only through the `TerminalEmulating` protocol in
`JanelaTerminal`. Nothing above that module may import SwiftTerm.

Treat **libghostty-vt as the planned v2 evaluation**, not a rejected option.

The protocol is deliberately about a dozen members: feed bytes, resize, snapshot
text, clear scrollback, and an event sink. That is the entire cost of switching
engines later, and it is small on purpose.

## Consequences

**Good.** A working terminal in days rather than months, in pure Swift, MIT
licensed, with no additional build toolchain. If upstream stalls we can vendor and
patch it — it is one SPM dependency of readable Swift.

**Good.** SwiftTerm's source doubles as our reference design for the PTY layer: the
`DispatchIO` water marks, the fd-close ordering that avoids `EV_VANISHED` crashes,
the fork/`login_tty` spawn shape, and populating `ws_xpixel`/`ws_ypixel` with
backing-scale-aware values so Sixel and SGR-pixel mouse mode are correct on Retina.

**Bad.** SwiftTerm is Swift 5 language mode, so it needs `@preconcurrency`
containment — see [0003](0003-concurrency-model.md).

**Bad.** We inherit its open correctness bugs, notably reflow and accessibility. If
one blocks us, we fix it upstream or in a fork rather than working around it in
Janela.

**Accepted risk.** Single-maintainer concentration. Mitigated by the MIT licence,
the vendorability of the source, and the protocol seam.

## Alternatives considered

**libghostty-vt now.** Best long-term ceiling and a Metal renderer. Rejected *for
v1 only*, because the C API is explicitly unstable, it adds a Zig build step to
every contributor's machine and to CI, and its Metal renderer is new enough that we
would be filing bugs rather than shipping features. Revisit deliberately.

**Write our own.** Rejected. It is a multi-month project that produces something
worse than both alternatives, and it is not where Janela's value is. See
[`../product.md`](../product.md) § Non-goals: we do not replace the user's tools,
and that includes their terminal's guts.

**xterm.js in a WKWebView.** The only reason to choose this is reuse from an
existing web IDE, and Janela has none. It would also contradict the native premise
outright.

## Revisit when

- libghostty declares its C API stable, **or** cmux's usage demonstrates the
  XCFramework path is low-friction enough to adopt.
- A SwiftTerm correctness or performance bug blocks a release and upstream is
  unresponsive.
- We need Kitty graphics or Sixel at a fidelity SwiftTerm cannot reach.
