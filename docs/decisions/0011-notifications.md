# 0011. Notification policy in the brain, delivery in the app

- **Status:** Accepted
- **Date:** 2026-08-19
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — detection moved
  into the daemon; policy moved to the client, because only a client knows what is
  focused. The policy/delivery split survives, one process to the right.

## Context

[ADR 0006](0006-agent-activity-signals.md) settles *where a signal comes from*:
BEL, OSC 9, OSC 777, OSC 133 marks, and process exit — never inference from agent
output. This ADR settles what happens next.

The user is looking at one terminal, in one tab, in one session. They may have
forty other terminals, and the app may not be frontmost. A signal from a terminal
they are staring at is noise. A signal from a session they left twenty minutes ago
is the reason the app exists. The difference is policy, and policy that is wrong is
worse than no notification at all, because the user stops trusting the badge.

Two forces pull against each other:

- **Policy must be testable.** "Notify only when the app is in the background, the
  terminal is unfocused, and we have not already notified for this terminal in the
  last 5 seconds" is three rules with an interaction, and it will grow. That kind
  of logic belongs where it can be unit-tested exhaustively and instantly.
- **Delivery is an app-level API.** `UNUserNotificationCenter` requires a bundle,
  an authorization prompt, and a delegate; `NSApp.isActive` and Dock badging are
  AppKit. None of that can be imported by `JanelaSession` without breaking the
  layering rule and making the brain untestable.

There is also a privacy constraint. OSC 9 and OSC 777 carry a *body string* the
user's own program supplied. Showing it in Notification Centre is the entire point
of the feature. Writing it to the system log would leak the user's private output
into a place they did not choose.

## Decision

Split policy from delivery at a protocol seam.

**The daemon detects; the client decides; the app delivers.**

[0015](0015-daemon-owned-sessions.md) forces this split. The daemon owns the
emulator, so it is what sees a BEL — but it has no idea which terminal the user is
looking at, whether any window is frontmost, or even whether a human is present. It
therefore emits `AttentionSignal` as a **fact**, over the protocol, to every
subscribed client, and makes no decision at all.

**`JanelaClient` owns policy.** It receives `AttentionSignal` from the connection,
applies the rules below against its own focus and activation state, and produces at
most one `AttentionDelivery`:

```swift
public protocol AttentionDelivering: Sendable {
    func deliver(_ delivery: AttentionDelivery) async
    func withdraw(for sessionID: SessionID) async
}
```

**`JanelaApp` implements it** over `UNUserNotificationCenter`, and owns
authorization, the delegate, and click routing.

Two consequences of the daemon that are worth stating rather than discovering:

- **No client connected means no notification.** The daemon will not deliver one —
  it has no GUI session to deliver into, and a background process posting
  notifications for work the user cannot see is worse than silence. The signal is
  still recorded on the terminal, so the badge is there when they return.
- **Two clients must not double-notify.** Each client applies policy for itself, so
  an attached phone and an attached Mac would both fire. The daemon stamps every
  signal with an id, and a client suppresses one it has already delivered; the
  cross-device case (Mac notifies, phone also notifies) is left alone deliberately,
  because those are two devices the user is not looking at simultaneously.

The rules, in order:

1. **Always update in-app state.** The terminal is marked, its pane shows an
   indicator, and the session button badges. This happens regardless of everything
   below — the sidebar is the primary channel, and it needs no permission.
2. **Never notify for the focused terminal in the frontmost window.** The user is
   looking at it.
3. **Notify to Notification Centre only when Janela is not frontmost**, or the
   signalling terminal is in a session that is not selected.
4. **Coalesce per terminal**, with a 5 s window. A build that rings the bell four
   times is one notification.
5. **Bells are quieter than notifications.** A bare BEL badges but does not deliver
   unless the user opted into "notify on bell"; an explicit OSC 9/777 always
   delivers, because the program asked for it by name.
6. **OSC 133 `D` with a non-zero exit code delivers when the command ran longer
   than 10 s.** Short commands failing is normal work, not an event.

Content rules:

- Title is the **session name**, subtitle the **terminal title** — the two things
  that let the user route the interruption.
- Body is the OSC payload when there is one, otherwise a generic sentence. We never
  synthesise a body from scrollback.
- **The body is never logged**, never included in an error report, and never
  persisted. It goes to `UNUserNotificationCenter` and nowhere else.
- Clicking a notification activates the app, selects the session, focuses the
  terminal, and withdraws the notification. A notification that lands you in the
  wrong place is worse than none.

**Authorization is requested lazily**, on the first delivery that would otherwise
occur, not at launch. A user who never leaves the app never sees the prompt, and
launch stays off the critical path. Denial is a supported state: the in-app badge
is unaffected, and we never ask twice.

The prompt is requested by the **app**, never by `janelad`. A notification
authorization dialog naming a background daemon is exactly the failure mode
[0017](0017-daemon-lifecycle.md) § TCC attribution describes, in a different guise.

## Consequences

**Good.** Every rule above is a unit test against a recording fake, with no
notification centre, no bundle, and no window server. The parts that are hard to
test are reduced to a nine-line adapter.

**Good.** The in-app path works with no permission at all, so the core feature —
"which of these wants me?" — never depends on a system prompt the user may have
denied years ago.

**Good.** The privacy line is unambiguous and enforceable in review: OSC payloads
reach exactly one API.

**Bad.** Two places to look when a notification is wrong. Mitigated by the seam
being one protocol with two methods; if it is not in `AttentionPolicy`, it is in
the adapter.

**Bad.** Coalescing means a genuinely distinct second signal inside 5 s is lost.
Accepted: the alternative is a stutter of notifications, which trains users to
dismiss without reading.

**Bad.** `withdraw(for:)` obliges us to track delivered identifiers per session, a
small piece of state that must be cleaned up when a session is deleted. It is
worth it — a notification for a session that no longer exists is a bug the user
sees.

## Alternatives considered

**Deliver from `JanelaTerminal`, at the point of signal.** Shortest path, and it
puts the notification next to the thing that knows. Rejected: the terminal layer
does not know which session is selected, whether the app is frontmost, or what
else has fired recently, so the policy would have to be threaded down to it — and
it would drag `UserNotifications` below the UI layer. After 0015 this option is not
merely wrong but impossible: `JanelaTerminal` runs in a daemon with no GUI session.

**Policy in the daemon, delivery in the client.** Tempting after 0015, since the
daemon already has the signal and could dedupe centrally for every client. Rejected
because the two most important rules — "not the terminal you are looking at" and
"only when the app is not frontmost" — are facts only a client holds. Shipping focus
state to the daemon on every window activation, to let it decide, is a chatty
protocol serving no one.

**Policy in the UI layer.** It has all the context naturally. Rejected because it
makes the rules untestable without a window server, and because a headless
`janela notify` CLI (the expected v2 of [0006](0006-agent-activity-signals.md))
would have no policy to reuse.

**Notify always, let macOS Focus modes filter.** Tempting: the OS already has a
"do not disturb" model. Rejected because the most important filter — "not the
terminal you are looking at" — is one only we can apply.

**A user-configurable rule engine.** Rejected on the concept budget. The settings
surface is one switch per class of signal, not a predicate builder.

## Revisit when

- A `janela notify` CLI ships and needs to enter the same policy path from outside
  the process. The seam should already accommodate it; verify rather than assume.
- Users report missed notifications that coalescing explains, at which point the
  5 s window becomes a measured number rather than a chosen one.
