# 0016. One transport-agnostic protocol, over a Unix socket in v1

- **Status:** Accepted
- **Date:** 2026-08-26
- **Amended:** 2026-08-21 by [0024](0024-tauri-client-shell.md) — the app's client is
  a WebView, which cannot open a Unix socket, so the Tauri shell opens it and relays
  frames over IPC. **The protocol, the framing, the handshake and the authentication
  posture are unchanged**; there is one more hop on the local path, and it is subject
  to the same no-base64 rule as the socket. The `Hello` and message sketches below
  are shown in their original Swift; the shipped shapes are in `@janela/protocol` and
  are the same shapes.
- **Amended:** 2026-09-08 by the request dispatcher (#35) — protocol **version 3**:
  `removalPlan` joins `ClientMessage` and is answered as `text` carrying the JSON of
  `SessionRemovalPreview`; `attach.viewport` becomes optional and an absent one means
  input and scope without rendering, which is the CLI rule below made explicit on the
  wire; and **every state announcement is a full snapshot**, because a client merges
  by id and merge-by-id cannot express a removal — see § Removals below. The minimum
  supported version moves with it: a v2 peer meeting a `removalPlan` or a viewportless
  `attach` would close the connection mid-session, so the ranges must not overlap. A
  v2 peer is refused with `incompatibleVersion` and no terminal is touched.
- **Amended:** 2026-09-09 by launch profiles (#38's wire, authored in #35) — still
  version 3, because the two land together and nothing has shipped between them:
  `saveLaunchProfile` (an upsert of a whole `LaunchProfile`, keyed by the id the
  client minted), `removeLaunchProfile`, and `createTerminal` — a terminal in a
  session that already exists, configured and not started, answered as `text`
  carrying the new `TerminalID`. `StateUpdate` gains `launchProfiles` and
  `launchProfileAvailability`. Availability is a separate record rather than a
  field on the profile because it is a fact about *this machine now* — it depends
  on the login-shell `PATH` only the daemon has — and installing a tool must not
  edit the user's profile. `isBuiltIn` crosses the wire and is **ignored** on
  save: a client able to set it could mint an undeletable profile.
- **Amended:** 2026-09-09 by the command surface (#37) — protocol **version 4**,
  two additions that make a split part of the session rather than an arrangement
  one window remembers: `createTerminal` gains an optional
  `placement: { kind: "split", beside: TerminalID, axis: Axis }` — the daemon
  splits the pane holding `beside` with `splitPane` and persists the result — and
  `removeTerminal` joins `ClientMessage`, stopping the process if it is live,
  dropping the descriptor and collapsing the layout, leaving one fresh idle shell
  behind when it was the session's last (ADR 0010's "never zero"). The minimum
  supported version moves to 4: a v3 daemon meeting `removeTerminal` falls off the
  end of its dispatch switch and answers *nothing*, so the client would wait on a
  reply that is never coming — worse than a refusal. A v3 peer is refused with
  `incompatibleVersion`, the daemon keeps running and no terminal is touched; the
  app shows the version-skew banner whose only button is "Restart the background
  service".

## Context

[0015](0015-daemon-owned-sessions.md) puts the state in a daemon. This decides how
anything talks to it.

Three consumers, arriving at different times:

| Consumer | When | Transport it needs |
| --- | --- | --- |
| `Janela.app` | now | local, same machine, same user |
| `janela` CLI (agent skills) | soon | local, same machine, same user |
| phone / web client | later | network, authenticated, encrypted |

Since [0023](0023-macos-first-portable.md) the third row is no longer speculative in
the way it was: the client packages are deliberately transport-agnostic so that a
browser client is a `MessageTransport` implementation rather than a second codebase.
That makes the foresight this ADR paid for more likely to be collected, and it does
not change any of the reasoning below.

Designing only for the first produces something that has to be replaced twice.
Designing all three now means building a network service nobody has asked to
connect to, and shipping an authentication system before there is a second machine.

The middle path has a specific failure mode worth naming: "transport-agnostic"
often means an abstraction layer invented for a second implementation that never
arrives, which is exactly the speculative generality
[`../product.md`](../product.md) warns against. The distinction that makes it worth
doing here is that the *protocol* — the messages, the framing, the handshake — is
expensive to change once a CLI exists in someone's scripts, whereas a *listener* is
cheap to add later. So the protocol pays for foresight; the transport does not.

There is also a hard, unglamorous constraint. A Unix domain socket path lives in
`sockaddr_un.sun_path`, which is **104 bytes on macOS** (measured on 26.2). The
obvious location is not viable:

```text
~/Library/Application Support/sh.janela.Janela/janelad.sock
  → 73 bytes with a 15-character home directory
  → grows with the username, leaving little headroom under 104
```

## Decision

**One protocol. Framing, messages and handshake are transport-neutral. v1 ships
exactly one transport: a Unix domain socket.**

### Framing

Length-prefixed binary frames. Not newline-delimited, because terminal payloads are
arbitrary bytes.

```text
┌────────────┬──────────┬─────────────────────┐
│ length u32 │ kind u8  │ payload             │
│ big-endian │          │ CBOR-ish or raw     │
└────────────┴──────────┴─────────────────────┘
```

- **Control messages are `Codable`**, encoded as JSON in v1. They are small, rare,
  and being able to read a frame in a log while debugging is worth more than the
  bytes.
- **Terminal payloads are raw bytes** in their own frame kind, never base64 inside
  JSON. This is the hot path; a 33% inflation plus an encode/decode pass per frame
  would be self-inflicted.
- **`length` is bounded** — 8 MB — and a frame claiming more is a protocol error
  that closes the connection. An unbounded length field on a socket is how you get
  a memory-exhaustion bug from a malformed first packet.

### Handshake and versioning

Every connection begins with a `Hello` before anything else is accepted:

```swift
struct Hello: Codable {
    var protocolVersion: Int        // integer, incremented on breaking change
    var minimumSupported: Int       // oldest the sender can speak
    var clientName: String          // "Janela.app", "janela-cli" — for logs and UI
    var credential: Credential?     // nil over a local socket in v1; see below
}
```

The daemon replies with its own range and either accepts or refuses. **A refusal is
never fatal to the daemon** — it keeps running, holding the user's terminals,
because the alternative is an app update killing an agent mid-task.

Version skew has one user-visible story, and the app owns it: *"Janela was updated.
The background service is still running your terminals on the previous version.
Restart it when you are ready — this will close your terminals."* Never automatic,
never silent.

### Authentication

The `credential` field exists in v1 and is unused by the local transport. That is
deliberate: adding a field to a shipped protocol is a breaking change, and this one
costs nothing to carry.

**Local socket authentication is the operating system's job.** The daemon:

- creates the socket inside a directory it owns with mode `0700`
- verifies the peer with `getsockopt(LOCAL_PEERCRED)` — `struct xucred`, verified
  76 bytes on macOS 26.2 — and **rejects any connection whose uid is not our own**
- records `LOCAL_PEERPID` for logs, and never trusts it for authorisation, because
  a pid is reusable

The peer check is a `getsockopt` call, and `bun:ffi` is gated to `@janela/pty` so
that Janela has exactly one FFI surface ([0021](0021-pty-native-layer.md)). The
listener therefore obtains the credential from whichever layer owns the descriptor
and passes it in, rather than calling `getsockopt` itself. The rule is unchanged;
only who makes the call is.

This is the same posture as tmux: any process running as you can talk to it, which
is not an escalation because such a process could already run anything as you. It
is still worth stating explicitly rather than discovering later.

When a network transport arrives it must carry a real credential, and it does not
get to reuse "the OS vouched for the peer".

### Socket location

```text
~/.janela/run/janelad.sock     → 40 bytes. Directory mode 0700.
```

Chosen over Application Support purely on the `sun_path` measurement above. The
database and everything else stay in
`~/Library/Application Support/sh.janela.Janela/`, per
[0005](0005-persistence.md); only the socket moves, and the reason is written down
here so nobody "fixes" the inconsistency later.

### Message shape

Request/response with correlation ids, plus unsolicited events. Sketch, not
signature:

```swift
enum ClientMessage {
    case hello(Hello)
    case subscribe(SubscriptionScope)      // projects, sessions, or one terminal
    case createSession(SessionCreationRequest)
    case removeSession(SessionID, RemovalOptions)
    case removalPlan(SessionID)            // what removing it would do (v3)
    case attach(TerminalID, viewport: GridSize?)  // absent viewport: no rendering (v3)
    case detach(TerminalID)
    case input(TerminalID, bytes: [UInt8])  // raw frame kind
    case resize(TerminalID, GridSize)
    case snapshotText(TerminalID, TextRange)  // what the CLI asks for
    case saveLaunchProfile(LaunchProfile)  // upsert; isBuiltIn ignored (v3)
    case removeLaunchProfile(LaunchProfileID)                            // (v3)
    case createTerminal(SessionID, profileID: LaunchProfileID?,
                        placement: Placement?)      // (v3; placement is v4)
    case removeTerminal(TerminalID)        // stops it, forgets it, collapses (v4)
}

enum DaemonMessage {
    case hello(Hello)
    case state(StateUpdate)                 // projects, sessions, terminal status
    case output(TerminalID, bytes: [UInt8]) // repaint sequences, raw frame kind
    case attention(AttentionSignal)
    case terminalExited(TerminalID, code: Int32)
    case failure(RequestID, UserFacingError)
}
```

Two rules that keep this honest:

1. **Every mutation is a request with a reply.** Fire-and-forget mutation is how a
   client's mirror silently diverges from the truth.
2. **`input` and `output` are the only high-frequency messages**, and both are raw
   frames. If a third joins them, that is a design smell worth an argument.

### Terminal size with multiple clients

Two clients attached to one terminal may have different window sizes, and the PTY
has exactly one `TIOCSWINSZ`. The daemon resolves it: **the size is the minimum of
all attached viewports**, which is tmux's rule and the only one that guarantees no
attached client is shown a screen it cannot fit. A client attaching with no
viewport (the CLI, reading text) does not participate.

A viewportless attachment is not a lesser attachment: it may type, and it is
subscribed to the terminal. It simply has no size to contribute and no screen to
repaint, so the frame loop never registers it. Participation is chosen at attach
time — a client that grows a window attaches again with a viewport.

### Removals

A `StateUpdate` carries whole objects and a client merges them by id, which can
express an addition and an edit but not a deletion. Two ways out: carry removed ids
alongside the objects, or make every announcement the complete list. We take the
second. It costs one pass over the sessions per announcement — human-rate work,
kilobytes — and it removes a whole class of bug where a client's mirror keeps a
session the daemon has forgotten. `isFullSnapshot` therefore reads "replace your
world with this", and a partial update is an addition or an edit, never a removal.

## Consequences

**Good.** The CLI is a client, not a feature. Everything it can do, the app can do,
because there is one vocabulary.

**Good.** The remote client becomes a listener plus a credential check, not a
redesign. The messages, framing and handshake do not change.

**Good.** Debuggability. Control frames are readable JSON; a `janela debug tap`
that prints frames is twenty lines.

**Bad.** JSON control frames are slower and larger than a binary encoding. Measured
against the fact that they are rare and small, this is the right trade, but it is a
trade — and it is why terminal data is explicitly *not* JSON.

**Bad.** We carry an unused `credential` field and a transport abstraction with one
implementation. That is speculative generality, accepted knowingly and bounded to
these two things.

**Bad.** Correlation ids, subscriptions and reconnection are real state machines in
both the daemon and the client, and they are the kind of code that is easy to get
80% right. Reconnect in particular must be tested with the daemon killed mid-frame.

**Bad.** The socket path convention splits our on-disk footprint across two
directories, for a reason that is invisible unless you know about `sun_path`.

## Alternatives considered

**XPC.** The macOS-native choice: launchd integration, `Codable` support, entitlement
model, no framing to write. Rejected because it cannot leave the machine and cannot
serve a non-Apple client, so the remote requirement would need a second protocol —
and two protocols for one daemon is worse than one imperfect protocol.

**gRPC / protobuf.** Real schema, real versioning, code generation for a future web
client. Rejected: a large dependency and a build-time codegen step
([0001](0001-project-generation.md) exists partly to avoid such steps) for a
protocol with roughly a dozen messages.

**JSON-RPC over the socket, including terminal data.** One encoding for everything
is simpler to reason about. Rejected on the hot path: base64-encoding every frame
of terminal output inflates it by a third and adds two passes per frame.

**WebSocket from the start.** Would make the web client trivial. Rejected for v1 as
the local transport — an HTTP upgrade handshake to talk to a process on the same
machine is ceremony — but it is the *expected* second transport, and the framing
above maps onto WebSocket frames with no message changes. [0023](0023-macos-first-portable.md)
commits to keeping that door open without walking through it.

**Shared memory for the grid.** The fastest possible local transport. Rejected:
it works only locally, it cannot be authenticated the same way, and the frame-rate
bounded output stream means we are not moving enough data to need it.

## Revisit when

- The second transport is actually built. That is the moment to check whether
  "transport-agnostic" was real or was a comforting story, and this ADR should be
  amended with the answer either way. Note there are now *two* local implementations
  — the daemon's socket listener and the app's Tauri bridge — which is weak evidence
  the seam is real, and not the test.
- Control-frame volume shows up in a profile, which would mean subscriptions are
  too chatty rather than that JSON was wrong.
- A client needs to attach to a terminal without being able to render it, beyond
  what `snapshotText` covers.
