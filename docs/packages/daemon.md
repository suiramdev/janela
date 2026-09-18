# @janela/daemon

Layer 6, daemon side: the Unix-socket listener, the per-connection record, the
handshake, subscriptions, peer-credential checks, and the frame loop that turns
terminal output into repaints.

What this package must **not** contain is the point of it. What a message *means*
belongs to `@janela/session` — the test for that is that `@janela/session` stays
usable with no socket at all — and `apps/daemon` holds nothing testable
([`architecture.md`](../architecture.md) § Daemon side). This is also the only
package that knows a socket exists, and it never binds and never chooses a path,
because launchd owns the socket; `apps/daemon` names `node:net` too, for the bind
alone.

## endpoint.ts

Where the daemon listens, and who is allowed to talk to it. Two unglamorous
constraints shape all of it, and both are easy to get wrong in a way that only
fails on someone else's machine.

`MAXIMUM_SOCKET_PATH_LENGTH` is 104 — `sizeof(sockaddr_un.sun_path)`, measured on
macOS 26. It is why the socket does not live beside the database in Application
Support: that path is already 73 bytes for a 15-character home directory and
grows with the username. `defaultSocketPath` counts **bytes, not characters**,
because `sun_path` is a byte array and a non-ASCII home directory costs more than
one byte per character. A path that does not fit throws `SocketPathTooLong` rather
than being truncated: a truncated `sun_path` does not error, it silently addresses
a *different* socket, which is a far worse outcome than not starting.

`SOCKET_DIRECTORY_MODE` is `0700`. The socket is a capability — anything that can
connect can start processes as this user — and the directory mode is the primary
defence, the peer-uid check the second. `verifySocketDirectory` therefore runs
before every listen rather than only where the directory is created, and refuses
unless the path exists, is a real directory, belongs to `ownUid`, and has
permission bits exactly `0700`. It compares **all twelve bits**, so setuid, setgid
and sticky are refused along with group and other access. It uses `lstat`, not
`stat`: a symlink pointing at a world-writable directory must fail here rather
than be followed into. `ownUid` is a parameter because `process.getuid` does not
exist in a WebView; the composition root reads it once.

A stat failure that is not `ENOENT` is **rethrown unchanged** rather than reported
as `missing` — a permission error on the way to the directory is not an empty
directory, and widening that check would turn an unreadable parent into "we will
create it". The classification decodes the error's `code` with a `Schema`, which
is the same fact the old `typeof`/`in` chain established. Not user-facing: the
caller logs it (non-negotiable 10).

`XUCRED_BYTE_LENGTH` is 76 and `XUCRED_VERSION` is 0, both measured on macOS 26;
arm64 and x86_64 share the layout. `verifyPeer` turns the raw `getsockopt` result
into a verdict, and **the order of its checks is the security-relevant part**:
every refusal path returns before `cr_uid` is read, so there is no way to obtain a
`PeerCredential` for a peer whose struct we did not first believe. A `getsockopt`
that reported fewer bytes did not fill the struct; a longer one carries a different
`cr_version`, which the next check catches. Little-endian is host order on both
macOS architectures, and these are the kernel's own bytes.

`pid` is `LOCAL_PEERPID` and exists for logs only — a pid is reusable and must
never be an authorisation input. It is `undefined` when that one call failed, which
is not a reason to refuse anything. `isAuthorized` is the uid rule on its own: the
peer is us, or it is nobody. That is not an escalation boundary — a process running
as the user could already run anything as the user — it is the boundary that keeps
a *different* user on a shared Mac out. Same posture as tmux.

### Where the `getsockopt` lives

`bun:ffi` is gated to `@janela/pty` and Bun 1.3 exposes no peer-credential
accessor, so the call is one more export on the PTY cdylib:

```text
jpty_peer_credential(fd: c_int, out: *mut u8, len: usize, out_pid: *mut i32) -> isize
```

It runs `getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, …)` and
`getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, …)`, returns the `optlen` the kernel
reported or `-errno`, and **interprets nothing**: the bytes cross untouched and are
read here. The listener that owns the accepted descriptor builds a
`RawPeerCredential` and calls `verifyPeer` before reading the handshake. If Bun's
socket API grows a peer-credential accessor, use it and delete this note.

### The closed failure sets

`SocketDirectoryProblem` and `PeerRefusal` are unions of `Data.TaggedClass`
reasons, the house shape from `frame.ts`
([`protocol.md`](protocol.md) § FrameError). Each tag is the string the old union
member was, so **no log field moved**: a refusal still reads
`refusal=uid-mismatch`. `socketDirectoryProblemLabel` and `peerRefusalLabel` are
the only way to turn one into a log field; branch with `Match.tag` or
`Predicate.isTagged`, never by reading `_tag`. The payload lives on the reason
rather than beside it — `wrong-mode` carries the bits found, `wrong-owner` the uid,
`uid-mismatch` the peer's uid — which is what keeps `{ mode: undefined }` from
existing for the three problems that have no mode.

A refusal is logged as a **shape** and never shown to the peer: the peer is told
`unauthorized` and nothing else, never which check failed. `SocketPathTooLong` and
`SocketDirectoryUnsafe` stay `UserFacingError` subclasses, because the
daemon/client decision is an `instanceof` one ([`support.md`](support.md) §
errors.ts).

## listener.ts

The only file in Janela that names `node:net`. Everything above it works against
`ConnectionListening` and `MessageTransport`, which is what lets the server's own
tests run in-process and a future WebSocket client be a transport rather than a
rewrite ([`architecture.md`](../architecture.md) § `MessageTransport`).

`socketListener` insists that the caller built the server with
`{ pauseOnConnect: true }` and handed it over **before** it listens. Two halves of
one rule. The constructor registers the `connection` handler, and the runtime drops
a connection accepted while there is none — so the bind must come after. And a
socket held in `pending` is still *flowing* unless the server paused it on accept,
so whatever the peer wrote before the accept loop reached it would be read off the
socket and discarded: the peer's `hello` vanishes and both sides wait for each
other. `pauseOnConnect` is a construction option Node's `Server` type does not
surface, so it is read back with a `Schema` decode of the live object — the only
way to hold a caller to it without an assertion.

`PENDING_CONNECTION_CAPACITY` is 16. Every accepted-but-unverified socket costs a
descriptor and can be opened by anything that can reach the socket, so the backlog
kept in *userland* is bounded and the kernel's own backlog does the rest.
**Shedding is the bound**: a peer that cannot be served now is better off
reconnecting than sitting in an unbounded queue (non-negotiable 9).

The credential reader is injected, and a reader that throws is treated as
`{ xucred: undefined, pid: undefined }`, which `verifyPeer` refuses as
`credential-unavailable`. The throw is an absence, not a second refusal reason, so
it is logged as a failure *class* and turned into that value.

### socketTransport

`incoming()` finishes when the peer disconnects cleanly and **throws when it does
not**, and both are ordinary outcomes: a client quitting is not an error, a client
crashing is not fatal to anyone else ([`protocol.md`](protocol.md) §
transport.ts). The throw a caller must expect is `FrameError` with reason
`truncated` — the peer went away mid-frame — plus whatever the socket itself threw.
Both are the connection's problem and nobody else's.

Yielded frames are **views** into the chunk or the decoder's buffer, valid only
until the next `push` — which cannot happen while the consumer holds one, because
the next chunk is read only when it asks for the next frame. `Buffer` is a
`Uint8Array`, so the chunk crosses with no copy and no conversion.

`send()`'s back-pressure **is the write callback**: with a peer that has stopped
reading it does not fire until the kernel buffer drains, so at most one frame plus
the socket's high-water mark sits in this process. That is the bound here; the
*queues* are one layer up, in `server.ts`, and a `BoundedQueue` inside this `send`
would double-buffer ahead of them and make `hasRoom` mean nothing. Concurrent sends
are ordered by `socket.write` itself, which is what lets the control and output
pumps write to the same socket.

`inFlight` holds the rejections for writes still in flight, with one pair of socket
listeners for the socket's life rather than a pair per frame, because this is the
hot path. A socket destroyed with a write outstanding does not reliably call that
write's callback, and a pump waiting on a promise nobody will settle is a
connection that never finishes closing. The `error` listener also keeps a socket
error from becoming an unhandled `error` event, which would take the daemon down
over one peer's connection.

`close()` sends FIN when nothing is outstanding, and destroys otherwise: the peer
is not reading what we already wrote, so there is nothing to preserve by waiting
for it. The `unauthorized` refusal frame is encoded once at module load.

## frame-loop.ts

The daemon's heartbeat: once per frame, drain every live terminal and send each
attached client the repaint it is owed. `FRAME_INTERVAL_MS` is 8 — one frame at
120 Hz, the same window `@janela/pty` coalesces reads into. Socket writes are
coalesced once per frame per attached client, and that is the reason a `yes` flood
never reaches a client: measured in the migration spikes, 132 MB/s off the PTY
became a bounded number of frames per second on the socket, with the event loop
staying within 2 ms of its interval. The budgets are
[`performance.md`](../performance.md) § "Terminal throughput" and § Interaction.

Four rules, all load-bearing:

1. **One drain per terminal per frame, N encodes.** `drain()` is the feed and
   `repaintFor()` is encode-only; draining per attached client would multiply the
   work by the number of windows.
2. **Every live terminal is drained, watched or not.** A terminal nobody has open
   still has to consume, or its child blocks in `write(2)` at the PTY's high-water
   mark and "your terminals survive the window closing" stops being true
   ([`survival-proof.md`](../survival-proof.md)). It is also where an exit and a
   lost descriptor are observed. A watched terminal the enumeration did not yield
   is fed by the encode pass, and still exactly once.
3. **A slow client applies back-pressure to its own stream and nothing else.** A
   phone on a bad connection must not slow down the Mac's window. `hasRoom` is
   consulted *before* the encode, so a stalled client costs no encode work — and a
   client with no room is re-owed a full repaint, because a dropped delta is
   incremental and the next delta does not supersede it.
4. **Nothing here is per-byte.** The loop touches counters and buffer views. Asking
   `LiveTerminal` for its state costs one small state object per live terminal per
   frame; nothing else in a frame allocates.

The interval exists only while something is attached or something is live: a daemon
holding forty idle terminals with no client attached costs no wakeups at all
(non-negotiable 5). `start` arms it, `tick` disarms it when there is nothing left to
drain and nobody attached, and `attach`/`wake` arm it again. Whoever can start a
terminal has to say so, because a missed wake costs the terminal nothing until the
next request or state change while a missed *drain* would cost its child a blocked
write — which is why the loop errs towards one extra empty frame rather than one
fewer.

A terminal whose `drain()` throws is one terminal's problem: letting it escape would
end the frame for every other terminal and, from a timer callback, take the loop
with it. The warning is logged once per failing terminal, and its clients are
re-owed a full repaint, so a terminal that comes back — a `restart` re-establishes
the descriptor — resumes with a whole screen rather than a delta against one nobody
has. A repaint that throws means the terminal is lost, not the connection: the loop
stops asking it for repaints and leaves its state to the registry.

`Attachment.full` is this side's debt, and it is not the only one: `owesSize` inside
`@janela/terminal` also forces the full path when a client's grid moved or its
viewport was overruled. They do not compete — `repaintFor` checks `owesSize` first
and delegates to `fullRepaintFor`, which discharges it — so a terminal recovering
from a drain failure while a resize is outstanding sends **one** full repaint, not
two. A test that asserts an exact repaint *count* across a recovery has to account
for both; `frame-loop.test.ts` asserts only that the frame after recovery is a full
repaint, which holds either way. Why there is nothing to account for on the drain
side — both end-of-stream paths keep the emulator, so `repaintFor` takes the path
it always did — is [`terminal.md`](terminal.md) § live-terminal.ts.

`LiveTerminal.drain()` swallows a lost descriptor into `state: failed` and rethrows
only emulator-originated errors, so the guard here is for the latter
([`terminal.md`](terminal.md)). `liveTerminals` is a separate dependency from
`terminals` because `TerminalRegistry` cannot enumerate itself: it answers `get`,
`inSession` and `liveCount`, and the loop needs "all of them" including the ones
nobody is watching. Pass a registry iterator here the day it grows one.

### Why the guards are `Result.try`, and why there is no latch

`feed` and the repaint both guard a call that can throw, and both use
`Result.try({ try, catch: errorName })` — synchronous, no fiber, and the `catch`
hoisted to a module constant so only the `try` thunk is per-call. Measured on an
M4 over 1,000,000 iterations: **1.42 ns** for a plain `try`/`catch`, **8.99 ns**
for `Result.try`, **123.61 ns** for `Effect.runSync(Effect.try(…))`. Per frame with
eight live terminals and two clients each — 24 guarded calls — that is **0.18 µs**
of the 8 ms frame for `Result.try` against 2.93 µs for the Effect form, which also
allocates a fiber per call and would put 2,880 of them per second into a process
that must show **bounded** growth under a flood
([`performance.md`](../performance.md) § Memory, § "Terminal throughput";
[`architecture.md`](../architecture.md) § "Effect at the seams" puts the frame
loop's per-frame work out of scope by name).

So the rule this file follows is narrower than "no Effect": no *fiber* and no
*await* on the frame path, and a construct whose cost is measured rather than
assumed. `Result.try` clears that; `Effect.runSync` does not.

The structural alternative — have `LiveTerminal.drain()` latch a failure field the
way `PseudoTerminal.drain()` latches `readFailure`, so `feed()` reads a field and
needs no guard at all — was proposed to `@janela/terminal` and **declined**, for a
reason worth keeping:

> The pty latch replaced a *closed* failure set the native layer had already
> computed (one errno band) with a domain state; what a `LiveTerminal.drainFailure`
> would have to latch is the *open* set "any defect inside `@xterm/headless`'s
> parser", and the only place to convert that into a field is a `try`/`catch`
> around `terminal.write` on the feed path inside `@janela/terminal` — so the latch
> would relocate the guard rather than remove it, and `frame-loop.ts`'s guard is in
> any case protecting the 120 Hz interval itself, which is the loop's invariant and
> not the terminal's.

`emulator.feed(bytes)` is the only thing that can propagate out of
`LiveTerminal.drain()` at all: `pty.drain()` latches, `readFailure` is a getter,
`exitCode()` and `close()` have no throw path, and `observeStreamEnd` throws
nothing itself. `headless-emulator.ts`'s `if (!this.parsed) throw` stays a throw on
purpose — it is a programming-error assertion in the same class as
`writeTerminalID`'s `TypeError` in `@janela/protocol`, and a library version that
queued writes asynchronously would be a bug that deserves a stack trace, not a
terminal that quietly goes `failed` while the loop logs a warning once and carries
on. So both `try`/`catch` blocks here stay, each with one live source — the library
— on a path where a throw from a timer callback takes the interval with it.

## dispatch.ts

What a message *means*, which is deliberately not the server's business. The seam
exists so the accept loop can be tested and reasoned about without the request
handlers, and so the handlers cannot quietly acquire a socket.

Every method on `ClientConnection` is **non-blocking**: a dispatcher handling a
request may not be made to wait on another client's socket, and `send` in
particular queues rather than writes. `request` is not awaited by the read loop, so
a slow `createSession` never delays the next keystroke — which also means it must
*answer* with `acknowledged` / `failed` / `text` rather than throw. A rejection is
logged and the connection survives.

**Field validation belongs here, not in the coder.** `decodeClientMessage` checks
the payload's `type` against an exhaustive table and stops
([`protocol.md`](protocol.md) § "Control frames are validated to the discriminant,
and no further"); a coder that validated fields would turn every bad field into a
dropped socket. So every field that reaches an algebra or a database is decoded
here with a `Schema`, and a malformed one becomes a `failed` reply: a viewport and
a resize (integers ≥ 1), a tab index and a request id (integers ≥ 0), a split
placement, and a launch profile — including **every element of its argv**, because a
number in there reaches `execve` as a stringified surprise and `["zsh", null]` is
not an argument list.

The decoders **validate rather than replace**: the value handed on is the one the
message already carried, because branding a `TerminalID` is `@janela/core`'s
decision and `identifier()` is the one place that makes it. `placement.beside` is
checked with `Schema.isGUID()`, whose pattern is exactly `identifier()`'s —
`isUUID()` additionally enforces version and variant bits and would reject ids
`identifier()` accepts. A non-string `title` on `createTerminal` is **dropped, not
refused**: an unusable title is a bad terminal, not a malformed request, and that
was the behaviour before.

A request id that is not a non-negative integer gets **no reply at all**: a `failed`
carrying a fabricated id would reject some *other* request on a client that
correlates by number. `inFlight` ids are held **per connection**, so one client's
in-flight work can never collide with another's — the ids are the peer's own
numbering and two peers routinely pick the same ones. A duplicate is dropped rather
than answered, because answering would settle the peer's promise for the request
still running.

`attach` never starts anything: attaching a viewport to an idle terminal shows an
idle terminal (non-negotiable 5), and `startTerminal` is the only path in the
daemon that spawns a process on request. **`attach` with no viewport is input and
scope only** — the terminal never learns about the client, so it takes no part in
size negotiation, the frame loop gets no registration, and the negotiated size is
whatever the rendering clients agreed. Participation is decided at attach time: a
`resize` from a connection that attached without a viewport is ignored rather than
promoted. A resize *is* an attach with a new viewport, because `LiveTerminal.attach`
upserts and re-runs the negotiation, so there is no separate resize path to keep in
step. Nothing is sent from an `attach` handler: **the frame loop owes the full
repaint** on its next frame, before any delta. `detach` is idempotent, because a
client recovering from a reconnect should not have to remember.

`removeSession` recomputes the plan here rather than taking the client's: a plan the
peer held may describe a session that has since gained a terminal or lost its
worktree. Only the answer to "also delete the directory" is theirs. `snapshotText`
requires no attachment — reading what is on screen is the CLI's whole job, and it
never renders.

`markSession` is the one request that moves attention by hand. It checks the
session exists and that `unread` decodes as a boolean — `decodeClientMessage`
stops at the discriminant, so a peer could send `"true"` — then calls
`markAttention` on every terminal the registry holds for that session and
`settled` on each, because a flag moved here is a state change no emulator
event will announce. Terminals with no process take the call and show nothing
for it: `state` answers `idle` before it reads the flag, so "Mark as Unread" on a
session whose terminals have all exited is a no-op the client already greys out.

`integrations` answers with a **text** reply carrying
`serializeIntegrationOverview`, the same shape as `removalPlan` and
`projectBranches`: a report per harness, read from the user's own configuration
files at request time rather than mirrored into the state snapshot. The overview
is not state a client merges — it is the answer to a question the Settings
screen asks while it is open, and putting it in `StateUpdate` would make every
state frame pay for four file reads. `installIntegration` and
`removeIntegration` acknowledge after the service call, so a client that sees
`acknowledged` may re-ask for the overview and get the truth.

All three take an `integrationID` off the wire, and all three check it with
`isIntegrationID` before it reaches the service. `decodeClientMessage` stops at
the discriminant, so `integrationID` arrives as whatever the peer typed; the id
selects a template that writes into a file under the user's home, which makes it
exactly the kind of field the paragraph above is about. An unknown one is a
`TypeError` and therefore a `failed` reply, like an impossible viewport.

`fullStateSnapshot` is composed **per announcement, not per frame**, so its cost is
human-rate. It exists because a client merges by id and therefore **cannot express
a removal**: the only way to say "that session is gone" is to send a complete list
without it ([`protocol.md`](protocol.md) § message.ts). Launch profiles are
announced from here rather than from `@janela/session` because the wire is their
only writer and they have no `StateObserving` path — which keeps the brain knowing
nothing about subscribers.

`errorName` is the log-field helper: the **name** of an error, never its message,
which is peer-influenced. For a `FrameError` it is `frameErrorLabel`, so the tag
reaches the log and the payload does not. `wireFailure` decides what reaches a
person: anything not already `UserFacingError` becomes one sentence with no detail,
because the underlying error may carry a path, a command line or a page of stderr
and a dialog is the wrong place for all three (non-negotiables 10 and 11).

`Match` runs once per *message*, which is human-rate; `Match.discriminatorsExhaustive`
fails to compile when a `ClientMessage` member has no handler.

## server.ts

Accepts connections and fans state out to them. Deliberately thin.

`HANDSHAKE_DEADLINE_MS` is 5 s. A connection that has not handshaken holds a
descriptor and a decoder and can be opened by anything that can reach the socket,
so it may not wait forever; five seconds is enormous for a local socket and small
enough that a stuck app launch does not accumulate.

`validatedHello` checks the peer's `hello` field by field, because the handshake has
**no reply channel yet**: a peer that sends `"2"` where a number belongs is refused
rather than compared against. That is the opposite rule from a request, and for the
same reason — there is nothing to answer with.

Refusal **never terminates the daemon and never touches a terminal**: the app being
too new is not a reason to kill an agent mid-task (non-negotiable 7, and
[`testing.md`](../testing.md) § "The daemon boundary": killing sessions on a version
mismatch is the worst bug this system can have). The same holds for a protocol
violation, a second `hello`, a handshake timeout, and shutdown: detaching a viewport
is not stopping a terminal, and the process keeps running with the size the
remaining clients negotiate. Hanging up is `apps/daemon`'s SIGTERM path and an
explicit user choice.

`serve` throws only when the *listener itself* fails — the socket vanishing, or a
descriptor we cannot accept on. A failure on any single connection is handled and
logged instead, because one client sending nonsense must never take down a daemon
holding another client's terminals.

`everyTerminal` reaches the terminals through the sessions because
`TerminalRegistry` has no iterator, and the loop needs the ones nobody is watching —
exactly the ones whose child blocks if they stop being drained.

`publish` awaits nothing: it runs inside `@janela/session`, which must never wait on
a socket (non-negotiable 8). It encodes once however many subscribers there are, and
deleting from the `Map` while iterating it is defined — which matters, because
`enqueueControl` disconnects a peer whose control queue is full. `canExitWhenIdle` is
false while any terminal is live, however many clients are connected, including
none: that asymmetry is the entire feature.

### The two bounded queues

| Queue | Capacity | Overflow | Why |
| --- | --- | --- | --- |
| `control` | 64 | `block`, guarded so it never blocks | Replies, state and attention. Nothing here may be dropped: a lost reply is data loss the client cannot detect, because the protocol has no request timeout. A peer holding 64 unread control messages has stopped reading, and is disconnected — which is lossless, because its reconnect re-subscribes and gets a full snapshot. |
| `output` | 32 | `dropOldest`, then re-owe a full repaint | Coalesced repaints. 32 frames is a quarter-second of 120 Hz output, and a client that far behind gains nothing from older diffs. The frame loop checks for room *before* encoding, so the bound is normally reached rather than exceeded. |

Dropping a coalesced repaint is safe only because the daemon *knows* it dropped one
and re-owes a full repaint — and only for the **rendering** attachments, since
registering a viewportless one would ask the terminal for a repaint for a client it
has never heard of. The same two numbers bound the app's Tauri bridge one hop
downstream, where overflow severs instead of dropping; see
[`performance.md`](../performance.md) § "Terminal throughput", which states them.

`enqueueControl`'s guard is what stops the `block` policy from ever engaging: a
blocked push would stall `publish` and with it the caller inside
`@janela/session`.

### Where Effect sits, and where it does not

A connection is a **resource lifetime**, and it is human-rate: one handshake, one
close, one refusal, one detach sweep per connection. Those run through
`Effect.tryPromise` + `Effect.catch` + `Effect.ensuring` under one
`Effect.runPromise` per connection, which is what guarantees the pumps are awaited
and the connection leaves `open` however the body ended — and the ordering matters,
because `closeConnection` finishes the queues and a `Promise.allSettled(pumps)`
before it would never settle. `serve`'s accept loop is the listener's lifetime and
has the same shape. A handshake failure is an **absence** — the peer went away — so
it is `Effect.option`, not a swallowed error.

Neither frame-path site here needs a `try`/`catch`, and neither carries a fiber.

`pump`'s send is a promise, so its failure is read with
`send(frame).then(DELIVERED, SEND_FAILED)` — two module-level thunks, so nothing is
rebuilt per frame. Measured on an M4: `await p.then(f, g)` is 73 ns against 52 ns
for `try`/`catch` around the same `await`, and 45 ns for the bare `await`. At one
frame per client at 120 Hz that is under 10 µs per second, which no row of
[`performance.md`](../performance.md) § "Terminal throughput" can see. An
`Effect.tryPromise` there would have been a fiber per frame per client, which is
what that budget does refuse.

`readLoop` has no guard at all, because the contract is that
**`RequestDispatching.input` never throws**. `dispatch.input` owns the failure: the
only throw on that path is `LiveTerminal.send` refusing a terminal whose child has
gone, which is a routine condition rather than a defect, and the dispatcher already
reports the other unusable case — an input frame from a connection that is not
attached — the same way. It costs a log line naming the error's class, and the
connection survives. That is one `Effect.try` per inbound raw frame, i.e. once per
keystroke: 299 ns measured on an M4, against 2 ns for the guard it replaced, which
is 29.9 µs per second at 100 keystrokes per second and 0.004% of one 8 ms frame.

An input frame naming a terminal this side does not hold raises `FrameError` with
reason `unknownTerminal` and closes the connection — and **never creates the
terminal the frame names** ([`protocol.md`](protocol.md) § FrameError).

`LEVEL_BY_CLOSE_REASON` marks two reasons `"silent"`, because the caller has already
logged the interesting part: the reason a connection failed or stalled is a field on
that record, and logging the close again would put two records where one belongs.

## terminal-events.ts

What a terminal did, turned into frames a client can read. `@janela/terminal`
reports to one `TerminalEvents` per terminal and knows nothing about connections;
this file is the whole of the translation, and the only place attention becomes a
message.

It is installed once, through `terminals.watch(terminalEvents)`, and assigns each
terminal's `events` as it is registered. That is the reason the registry replays
what it already holds: terminals restored before the server was listening are
exactly the ones whose reports would otherwise go nowhere.

Three kinds of thing go out, all through `broadcast`, which encodes once and hands
the frame to every state-scoped connection's `enqueueControl` — the bounded,
never-dropped queue above, not a path of its own. A client that is not subscribed
to state gets none of it, and a client that has stopped reading is disconnected by
the same rule as any other control traffic.

- A **partial `StateUpdate`** carrying one terminal's state:
  `isFullSnapshot: false`, every other collection empty. A state change is a fact
  about one terminal, and re-sending the projects and sessions to say a percent
  moved would put the cost of a snapshot on the most frequent message the daemon
  sends.
- An **`attention`** signal for a bell, a notification, a finished prompt, or an
  agent that is waiting or has finished, each with the terminal and session it
  came from, an id, and the time it happened. The
  state frame goes first: a client that renders the signal before it has the state
  behind it would badge a terminal it still believes is idle.
- A **`terminalExited`** frame after the state frame, for the same reason.

**A state frame is sent only when the state actually changed**, which is decided by
comparing a `stateSignature` string against the last one published for that
terminal. This is not an optimisation of an edge case. `OSC 9 ; 4` is commonly
emitted on a timer — a 1 Hz keepalive repeating the same percent is ordinary
behaviour — and without the comparison a single downloading terminal would send
sixty identical frames a minute to every connected client, each one a wake-up and
an encode. With it, an unchanged keepalive costs one map lookup and produces
nothing. The signature includes the progress kind and percent **and the agent
activity**, so a *real* change still goes out on the next report.

The map is keyed by terminal id and cleared in `terminalRemoved`, so a terminal
that is removed and re-registered publishes its first state rather than being
deduped against a predecessor's.

**An agent's activity is state; only waiting and finished are also a signal.**
`onActivity` always reconciles, and raises `{ kind: "activity", activity }` for
`waiting` and `finished`. `working` is deliberately state-only: a harness
reports it at every prompt and after every tool call, and a notification per
tool call is a notification nobody would keep switched on. The two that do
interrupt are the two the user asked to be told about — the agent wants
permission, or it is done — and `@janela/client` decides whether either becomes
an actual notification (`AttentionPreferences`, [`client.md`](client.md)). The
repeat rule is not symmetric and that is intentional: `reconcile` dedupes
identical state, so a `working` heartbeat costs one map lookup, while a repeated
`waiting` raises again, because a harness only re-asks when it is asking again.

`server.ts` also calls `reconcile` directly after `dispatch.input`: sending input
clears attention on the terminal, and that is a state change no terminal event will
announce, because it originated on this side. Two more call sites exist for the
same reason. The frame loop's `settled` hook is `reconcile`, invoked once per
**full** repaint and never per delta: a full repaint is the moment
`fullRepaintFor` lowers the flag, and before the hook existed the daemon knew a
session had been looked at while every client kept drawing it unread until the
next unrelated event. And `dispatch`'s `settled` option is the same function,
which `markSession` calls per terminal after `markAttention` — a request that
moves state the emulator will never announce.

**Notification bodies are never logged** (non-negotiable 11). The relay carries
them to clients and writes only shapes to the log: a terminal id, the attention's
kind, an exit code. The body passes through `attentionKind` and into the frame
without ever reaching `log`.

## Tests

The daemon boundary's failure modes are the ones that did not exist before the
split, which makes them the most likely to be under-tested; the list lives in
[`testing.md`](../testing.md) § "The daemon boundary".

`listener.test.ts` binds a **real Unix socket** in a `temporaryDirectory` and
connects real clients, because every interesting bug here is a real-socket bug: a
frame split inside its length prefix, a length prefix claiming a payload that never
comes, a peer that vanishes mid-frame, a peer that stops reading until the kernel
buffer fills. An in-process transport cannot tell us any of that. The fixture
asserts its own socket path fits `sun_path` before it binds, because a truncated
path would silently address a different socket.

`server.test.ts` and `dispatch.test.ts` drive the server over an in-process
rendezvous transport instead. A rendezvous rather than a buffer, because the
interesting behaviour is exactly what happens when a peer stops reading — a buffered
channel would let a stalled client look healthy. The socket is never faked; the
registry, the transport and the three services are, because the logic under test is
the *decision*: which client gets which frame, and who is disconnected.

`dispatch.test.ts` uses the **real** dispatcher, with no `dispatch` override, and
sends deliberately ill-typed control frames through `wireControl`, which JSON-encodes
whatever it is given. That is what the wire can carry, and building the frame by hand
is how a test says so without an assertion the compiler would have to be lied to for.

Real timers are deliberate in three places: the handshake deadline is a `setTimeout`,
the frame loop a `setInterval`, and the cold-start test needs a window in which a
connection sits accepted with nobody accepting. Those claims are about the platform
clock, so fake timers would assert about the mock rather than about the code; every
wait is on a *condition* with a generous deadline, so a failure points at the
condition rather than at a guessed sleep and a loaded machine does not flake.

Fixture identifiers are real UUIDs derived from the fixture's name, so
`fakeSession("session")` and `fakeTerminal`'s default session agree across files and
every id would survive `identifier()` — which matters now that the dispatcher
validates one with `Schema.isGUID()`.
