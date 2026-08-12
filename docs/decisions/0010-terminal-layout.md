# 0010. Splits and tabs are a persisted layout tree, not a multiplexer

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

A session is a place of work, and a place of work is usually more than one running
program: an agent, the dev server it is poking at, and a shell to check things in.
Users expect to arrange those side by side and to find them where they left them.

There are three ways to provide that.

**Delegate to tmux.** Ship nothing, tell users to run a multiplexer. It works
today, costs us zero code, and is what the previous version of this document
recommended. It also means the app's own sidebar cannot see inside a session — one
tmux process is one terminal to us, so "which of these wants attention" degrades to
"something in there beeped", and OSC 133 prompt marks arrive from the multiplexer's
own shell rather than the program the user cares about.

**Model it as view state.** Let SwiftUI hold the arrangement, do not persist it.
Cheapest to build. The failure is on relaunch: everything the user arranged is
gone, which contradicts the claim that returning to a place is free.

**Model it as data.** A layout tree on the session, persisted with it. More design
work, and it introduces a recursive `Codable` type, which is a decoding hazard if
left unbounded.

There is also a keyboard problem that constrains all three. Every chord a
multiplexer uses is a chord a TUI might want: `Ctrl-b`, `Ctrl-a`, and the arrow
keys are all spoken for. Janela's non-negotiable is that the terminal owns the
keyboard.

## Decision

Sessions own a `SessionLayout`, persisted with the session:

```swift
public struct SessionLayout: Hashable, Sendable, Codable {
    public var tabs: [Tab]                 // ordered, user-arranged
    public var focusedTabIndex: Int
}

public indirect enum Pane: Hashable, Sendable, Codable {
    case terminal(TerminalID)
    case split(axis: Axis, fraction: Double, first: Pane, second: Pane)
}
```

A binary split tree per tab, referencing terminals by id. Bounded and validated:

- **Depth ≤ 6.** Encoding rejects deeper trees; decoding truncates and logs. This
  is what makes a recursive `Codable` type safe to load from a file the user could
  in principle edit.
- **`fraction` clamped to `0.05...0.95`.** A pane you cannot see is a pane you
  cannot close.
- **Referential integrity is repaired, not enforced.** A pane naming a terminal
  that no longer exists is dropped on load. Refusing to open the session would be
  the wrong trade for a cosmetic inconsistency.
- **Closing collapses.** Removing a terminal promotes its sibling into the parent's
  place. The last terminal in a tab closes the tab; the last tab leaves the session
  holding a single idle terminal, never zero.

Keyboard: `⌘`-based only, and only where macOS apps already use it — `⌘D` /
`⌘⇧D` to split, `⌘⌥←→↑↓` to move focus, `⌘⇧[` / `⌘⇧]` for tabs, `⌘W` to close a
pane. **No `Ctrl` chord is ever bound**, no key is intercepted before the terminal
sees it, and there is no configurable binding surface.

What this explicitly is **not**:

- No detach/attach. No layout survives the app exiting; only its *description*
  does, and terminals come back idle.
- No scripting, no layout files, no named layouts, no "save this arrangement".
- No cross-session drag of a terminal in v1. It is a plausible addition; it is not
  scope.

## Consequences

**Good.** The sidebar keeps its resolution: each terminal is individually visible
to the attention machinery, so "the agent in the left pane finished" is a thing the
app can actually say. This is the argument that decides it — see
[0006](0006-agent-activity-signals.md).

**Good.** Relaunch restores the arrangement at ~zero cost, because restoring a
layout is restoring descriptors, and descriptors are idle
([0009](0009-projects-sessions-terminals.md)).

**Good.** Bounds are stated in the type rather than in a comment, so the decoding
hazard of a recursive enum is closed by construction.

**Bad.** Split rendering, focus traversal and resize handling are real UI work,
including the fiddly parts: a split that resizes must coalesce `TIOCSWINSZ` calls,
and each resize is a full reflow in the emulator
([`../performance.md`](../performance.md) § Rules of thumb).

**Bad.** We now own a layout algebra, and every operation on it — split, close,
promote, focus-next — needs a test. That is a fixed cost we accept once.

**Bad.** Users who want tmux's power will find this deliberately thin. The answer
is that tmux still runs inside a terminal, and we have not taken its keys.

## Alternatives considered

**Tell users to run tmux.** Rejected on the attention argument above: it blinds the
one feature the product is judged on. It remains fully supported, just not the
answer to "arrange two things side by side".

**Splits as ephemeral view state.** Rejected: an arrangement that does not survive
relaunch fails the product's core claim.

**A list of panes with a layout mode (`.horizontal`/`.grid`), no tree.** Genuinely
tempting — no recursion, no depth bound, trivially `Codable`. Rejected because the
common real arrangement is asymmetric (a tall agent pane beside a short server log
above a shell), and a mode enum cannot express it without growing into a tree
anyway.

**Terminals as top-level siblings of sessions, arranged by the window manager.**
This is what a plain terminal emulator does. Rejected: it puts the arrangement
outside the session, so switching sessions stops being one action.

## Revisit when

- Users are routinely nesting past depth 3, which would suggest the tree is being
  used as a workspace layout rather than a working arrangement.
- Moving a terminal between sessions is asked for more than once — it is an
  additive change to the same model, not a replacement of it.
