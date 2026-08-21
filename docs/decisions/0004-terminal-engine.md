# 0004. SwiftTerm behind a protocol; libghostty as the v2 option

- **Status:** Superseded by [0018](0018-terminal-engine.md)
- **Date:** 2026-08-12

> SwiftTerm is not available to the new stack. The *shape* this ADR established —
> two seams, a headless emulator in the daemon and a renderer in the client, each
> behind a protocol of about a dozen members — survived the migration intact, which
> is the strongest available evidence it was a real boundary. See
> [0018](0018-terminal-engine.md), including what the two-seams-**one-library** rule
> cost to give up.
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — the emulator
  moved into the daemon and the single seam became two. The engine choice itself is
  unchanged.

## Context

The terminal is the product. Its emulator must handle the full xterm sequence set,
scrollback, reflow, mouse reporting, bracketed paste, and the alternate screen,
because every coding agent we intend to host is a full-screen TUI that uses all of
it.

Reflow deserves particular weight here. Splits mean a terminal is resized whenever
its neighbour is dragged ([0010](0010-terminal-layout.md)), so reflow is not a
window-resize edge case — it is an interactive path, and its correctness and cost
are both load-bearing.

Since [0015](0015-daemon-owned-sessions.md) there are two distinct jobs where there
used to be one, and separating them precedes choosing anything:

- **Interpreting bytes into a screen**, in the daemon, headless. No fonts, no
  drawing, no AppKit — a state machine and a grid.
- **Drawing a screen**, in each client. No PTY, no child process: it receives escape
  sequences over a socket exactly as a real terminal receives them from a pty, and
  paints.

SwiftTerm already draws this line internally — `Terminal` is the headless VT state
machine, `TerminalView` is the AppKit surface built on it. That the library splits
the same way we now need to is why this ADR survives 0015 with an amendment rather
than a replacement.

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

Ship **SwiftTerm** on both sides of the socket, reached only through two protocols:

| Seam | Module | Backed by | Owns |
| --- | --- | --- | --- |
| `TerminalEmulating` | `JanelaTerminal` (daemon) | `SwiftTerm.Terminal` | Authoritative grid, scrollback, damage tracking, text snapshots |
| `TerminalRendering` | `JanelaTerminalUI` (client) | `SwiftTerm.TerminalView` | Painting, fonts, selection, keyboard input |

Nothing outside those two modules may import SwiftTerm. The rule has not changed;
there are simply two places it applies rather than one.

Treat **libghostty-vt as the planned v2 evaluation**, not a rejected option. Note
that 0015 improves its odds: libghostty-vt is a *VT library*, not a renderer, which
is exactly the shape of the daemon-side seam.

Each protocol is deliberately about a dozen members. `TerminalEmulating` is feed,
resize, damage-since-revision, serialise-for-attach, snapshot text, clear
scrollback, and an event sink; `TerminalRendering` is feed, resize, focus, and a
selection accessor. That is the entire cost of switching engines later, on either
side independently.

One member is new and load-bearing: **serialise-for-attach**, which turns the
current grid into the escape sequences that reproduce it. It is what makes
reattaching correct rather than lucky, and it is the piece SwiftTerm does not give
us — see 0015 § Consequences for the honest accounting of that cost.

## Consequences

**Good.** A working terminal in days rather than months, in pure Swift, MIT
licensed, with no additional build toolchain. If upstream stalls we can vendor and
patch it — it is one SPM dependency of readable Swift.

**Good.** SwiftTerm's source doubles as our reference design for the PTY layer: the
`DispatchIO` water marks, the fd-close ordering that avoids `EV_VANISHED` crashes,
the fork/`login_tty` spawn shape, and populating `ws_xpixel`/`ws_ypixel` with
backing-scale-aware values so Sixel and SGR-pixel mouse mode are correct on Retina.

**Good.** Using the same engine on both sides makes the repaint encoder testable the
obvious way: feed bytes to a daemon-side emulator, encode the damage, feed the
result to a second emulator, and assert the two grids are identical.

**Bad.** Retina pixel metrics (`ws_xpixel`/`ws_ypixel`) are a *client* fact, but the
daemon is what sets the window size. A client on a non-Retina display attached
alongside a Retina one makes this genuinely ambiguous, and 0016's minimum-viewport
rule sizes the grid in cells, not pixels. Sixel fidelity across mixed-DPI clients is
a known open edge.

**Bad.** SwiftTerm is Swift 5 language mode, so it needs `@preconcurrency`
containment — see [0003](0003-concurrency-model.md).

**Bad.** We inherit its open correctness bugs, notably reflow and accessibility.
Reflow is the one that interacts with splits, so it is the first thing to profile
once pane dragging exists — and it now happens daemon-side, where a bug corrupts the
authoritative state rather than one window. If one blocks us, we fix it upstream or
in a fork rather than working around it in Janela.

**Bad.** The dependency is now linked into two binaries, one of which is a background
daemon that must not crash. A parser fault that used to lose a window now loses every
terminal the user has running, which raises the bar on fuzzing the feed path.

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
  XCFramework path is low-friction enough to adopt. The daemon-side seam is now the
  natural first place to try it, independently of what the app renders with.
- A SwiftTerm correctness or performance bug blocks a release and upstream is
  unresponsive.
- We need Kitty graphics or Sixel at a fidelity SwiftTerm cannot reach, or the
  mixed-DPI pixel-metrics edge above stops being theoretical.
