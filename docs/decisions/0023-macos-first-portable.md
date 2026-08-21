# 0023. macOS first, portable underneath

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** [0002](0002-macos-deployment-target.md), and the **Not
  cross-platform** bullet in [`../product.md`](../product.md) § Non-goals.
- **Amends:** [`../product.md`](../product.md) § Principles 4 and 5.

## Context

`../product.md` § Non-goals said: *"**Not cross-platform.** Native macOS is the
point. Portability is a cost we are choosing to pay for depth. Revisit only with an
ADR."* This is that ADR, and the revisit was requested rather than discovered.

Three things make the question different from when it was answered.

**The daemon already made the client replaceable.**
[0015](0015-daemon-owned-sessions.md) moved everything durable out of the window and
[0016](0016-daemon-protocol.md) made the protocol transport-agnostic, explicitly so
that *"the CLI and a phone are clients, not features"*. `../architecture.md` already
anticipated the specific case: escape sequences are shipped because *"every client
already knows how to consume them. SwiftTerm on macOS, **xterm.js on the web**, a
real terminal for the CLI."* The portability seam was designed in; this ADR decides
to stop declining to use it.

**The remote client was already scope, and it was already a web client.**
`../product.md` lists "connecting to your own Mac from a phone" among the things the
daemon exists to enable. A phone client is not going to be AppKit. So the codebase
was already committed to a second, non-native renderer — the only question was
whether it would share code with the first.

**The single-process premise that justified the native stack is gone.** 0002's case
for macOS 15 was about SwiftUI APIs for window chrome and navigation. Since 0015 the
app renders a mirror and delivers notifications. It is a thinner thing than it was
when 0002 was written.

What has *not* changed is that macOS is the product. The users are macOS developers,
the competition is native, and "runs everywhere, feels like nowhere" is a real and
common failure.

## Decision

**macOS is the first-class target and the only one we ship. The architecture does not
foreclose a browser client, and we do not pay to reach one before it is asked for.**

Concretely, three commitments:

### 1. macOS is what we build, test and ship

There is no Linux or Windows build, no CI matrix beyond macOS, and no bug is a bug
because it appears on another platform. Tauri's portability is an **asset, not an
obligation** ([0024](0024-tauri-client-shell.md)). If someone asks for Linux, the
answer is still no — but it is now "not yet, and it would cost testing and support"
rather than "never, and it would cost a rewrite".

### 2. The browser-client seam is real, and it is exactly one file

`@janela/client` takes a `MessageTransport` and never learns what carries the bytes.
The desktop app supplies one backed by Tauri's IPC, because a WebView cannot open a
Unix socket and the Rust shell opens it instead. A browser client supplies one backed
by a WebSocket — the transport 0016 already named as *"the expected second
transport"*.

That is the whole seam, and it is the reason for constraints that otherwise look
like fussiness:

- `@janela/support` is isomorphic. Its subprocess half lives behind
  `@janela/support/process`, which the layering gate marks daemon-only, so the
  shared package can link into a WebView.
- `@janela/client`, `@janela/design`, `@janela/terminal-ui` and `@janela/ui` import
  nothing platform-specific. `@tauri-apps/*` is gated to `apps/desktop` alone.
- Domain values are plain and JSON-shaped: timestamps are ISO strings, paths are
  strings. A `Date` needing a revival pass on the far side is one forgotten call site
  from a bug.

**We are not building the web client.** No server, no auth, no listener — 0016 was
right that a listener is cheap to add later and a protocol is expensive to change.
What we are doing is not spending anything to keep the door open, and refusing
changes that would close it.

### 3. Principles 4 and 5 are revised rather than quietly dropped

This is the honest part, and the reason this ADR exists rather than a one-line edit.

**Principle 4, "Native, and it should feel like it", survives as a requirement and
loses its justification.** The requirement was never "written in Swift" — it was
sheets, the standard sidebar, real menu commands, keyboard navigation, Notification
Centre, Increase Contrast, Reduce Motion, dark mode via semantic colours. Those are
still required, and most are still reachable: the menu bar and notifications are
genuinely native through the Rust shell, and `prefers-color-scheme`,
`prefers-contrast` and `prefers-reduced-motion` are the web's spelling of three of
the others.

What is genuinely lost: AppKit controls, and with them the last few percent of
"indistinguishable from a native app" — scrollbar behaviour, text-field affordances,
sheet physics, and the accumulated correctness of controls we did not write. A
WebView imitation of a macOS control is usually close and occasionally wrong, and
users of developer tools notice. **That is a real cost, paid deliberately.** The
mitigation is discipline: the chrome that macOS owns — menus, notifications, file
dialogs, the window — is native, and `@janela/design` is small and closed rather
than a re-creation of AppKit in CSS.

The sentence in principle 4 pointing at the terminal-engine ADR "for the part of
that argument that is measurable rather than aesthetic" no longer holds: that
argument now runs the other way ([0018](0018-terminal-engine.md)).

**Principle 5's budgets are revised, not deleted.** They were: 250 ms cold launch,
one frame per session switch, 40 sessions normal, and terminal throughput surviving
`yes` without dropping below 60 fps.

| Budget | Before | Now | Why |
| --- | --- | --- | --- |
| Cold launch → interactive | 250 ms | **400 ms** | A WebView process plus a JS bundle is a real cost and pretending otherwise would make the budget decorative. |
| Warm launch | 120 ms | **200 ms** | Same. |
| Session switch | 1 frame | **1 frame** | Unchanged. It shows a view; it starts no work. |
| Tab switch, project expand | 1 frame | **1 frame** | Unchanged, and expanding still reads nothing from disk. |
| Keystroke → glyph | 1 frame | **1 frame** | Unchanged, and now crosses one more boundary — see below. |
| 40 open sessions | normal | **normal** | Unchanged. An unstarted terminal is still a value. |
| Terminal throughput | ≥100 MB/s, 60 fps | **≥100 MB/s, 60 fps** | Unchanged, and measured: 133 MB/s off the PTY, ~140 MB/s into the emulator with coalesced writes. |

The launch budgets moved and nothing else did. That is not a coincidence: 0015
already removed everything expensive from the launch path and made the window paint
before the daemon answers, and the frame-rate budgets are met by the daemon
absorbing floods, which is unaffected by what renders.

The keystroke path is the one to watch and the one to defend. A character now travels
WebView → Tauri IPC → Rust → socket → daemon → PTY, and its echo comes back. Each hop
is tens of microseconds; the sum is still far under a frame. **If it regresses, the
fix is the IPC path, not moving the terminal back into the app.**

Two budgets are added, because the new architecture has two costs the old one did
not:

- **Terminal bytes crossing Tauri's IPC: no JSON, no base64.** Raw payloads only. A
  33% inflation plus two passes per frame is exactly the mistake 0016 refused to make
  on the socket, and it would be no less a mistake here.
- **Memory per idle session stays flat.** A JavaScript heap makes "an unstarted
  terminal costs a struct" less automatically true than it was.

## Consequences

**Good.** The phone client `../product.md` promises stops being a future project and
becomes a transport plus a listener. The same is true of the CLI, which never needed
this but is now unambiguously cheap.

**Good.** One language across the daemon, the client and the tooling, and — more
importantly — **one copy of `@janela/core` and `@janela/protocol`**. A second native
client in another language would mean maintaining the domain model and the wire
format twice, in agreement, forever.

**Good.** The web platform's accessibility and internationalisation story is
genuinely good, and some of it is better than what we would have written.

**Bad.** The last few percent of native feel, as above. This is the cost, it is not
recoverable by trying harder, and it should be re-examined honestly once there is a
real UI to look at rather than argued about now.

**Bad.** Two launch budgets got worse. Users will not perceive 400 ms as slow, but the
number moved and the document now has to defend a weaker one.

**Bad.** A standing temptation. Every future feature can now be argued for on the
grounds that it would also work on Linux. It will not, because we do not test there
— and this ADR is the thing to point at.

**Bad.** "macOS-first but portable" is a position that erodes in one of two
directions unless it is defended. Either the portability rots because nothing checks
it, or the macOS-first part rots because someone files a Linux bug. The defence is
this ADR plus the layering gate, which makes the platform-specific/portable boundary
mechanical rather than cultural.

## Alternatives considered

**Stay native macOS, port nothing.** The status quo, and it has a real virtue: it is
the only option that fully keeps principle 4. Rejected because the user asked to
revisit it, because the phone client in `../product.md` is not reachable this way
without a second codebase, and because 0015 already made the client the thin part.

**Cross-platform now: ship Linux and Windows too.** Tauri would mostly permit it.
Rejected outright. Testing and supporting three platforms is a cost with no user
asking for it, and it is the fastest route to "runs everywhere, feels like nowhere",
which is the thing principle 4 exists to prevent.

**Native macOS client plus a separate web client for remote.** Best of both, in
principle. Rejected: two clients means two implementations of the mirror, the
attention policy, the layout renderer and the terminal surface, kept in agreement by
hand. That is precisely the duplication a shared protocol was supposed to prevent.

**A native shell with a WebView only for the terminal.** Would keep AppKit controls
for chrome and use the web only where the renderer is. Genuinely interesting, and
rejected because it is the worst of both: two UI toolkits in one window, two focus
models, two accessibility trees, and a Swift codebase retained for chrome.

## Revisit when

- The native-feel gap shows up in real feedback about the actual UI, rather than in
  anticipation. That is the point at which "how much is recoverable" becomes a
  concrete question.
- Someone actually builds the browser client. That is the moment to check whether
  this seam was real or a comforting story, and this ADR should be amended with the
  answer either way — the same test 0016 set for itself.
- A launch or keystroke budget above is missed on real hardware.
- Linux or Windows is requested by enough real users that the testing cost is worth
  arguing about. It would need its own ADR, and this one is not it.
