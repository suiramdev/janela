# @janela/protocol

Layer 2: frames, messages, the handshake, and the transport seam both processes
share. Pure and JSON-encodable, with no idea how either side is implemented.
Changing anything here is a wire-compatibility decision.

What this package deliberately does not know: that a Unix socket exists, that one
of its peers is a WebView, or that the daemon holds a database. It is the widest
part of the design and the thinnest part of the code.

## bytes.ts

Private to this package: none of it is protocol vocabulary, and
`@janela/support`'s `bounded.ts` is queues and water marks, not byte access.

A `DataView` would read the length prefix just as well, but constructing one is
an allocation per frame on the hot path, and this package is on both sides of
every repaint. `byteAt` is a plain indexed read with the bounds check
`noUncheckedIndexedAccess` asks for, which is also the check we want. It throws
`RangeError` rather than `FrameError` because every caller checks the length
first: a throw there is a bug in this package and deserves a stack trace, not a
closed connection.

`readUint32BE` finishes with `>>> 0` because the shift that builds it is signed.
A length with the high bit set would otherwise read as negative — exactly the
value that slips past a `length > MAXIMUM_PAYLOAD_LENGTH` check.

## frame.ts

One unit on the wire is length-prefixed rather than delimited, because terminal
payloads are arbitrary bytes and there is no byte we could reserve as a
separator.

```text
┌────────────┬─────────┬──────────────────────┐
│ length u32 │ kind u8 │ payload              │
│ big-endian │         │ JSON, or raw bytes   │
└────────────┴─────────┴──────────────────────┘
```

`length` counts the payload only. There are exactly three kinds. Control traffic
is rare and small, so it pays JSON's cost for readability in logs; terminal
traffic is the hot path and is never encoded at all. A fourth high-frequency kind
is a design smell worth an argument first.

`MAXIMUM_PAYLOAD_LENGTH` is 8 MB. An unbounded length prefix read off a socket is
a memory-exhaustion bug waiting for a malformed first packet. A full repaint of a
very large grid measured well under 1 MB in the migration spikes, so 8 MB is far
above any legitimate frame and far below anything that would hurt.

`encodeFrame` writes one contiguous buffer, and therefore copies the payload
once, because Bun's sockets do not coalesce writes: a header write followed by a
payload write is two syscalls per frame, and at repaint rates that costs more
than the copy.

`frameDecoder` is stateful because a socket delivers arbitrary chunk boundaries:
a frame header can arrive split across two reads, and a reader that assumes
otherwise works until the day it does not. Frames it returns are **views** — one
that completed inside the pushed chunk aliases that chunk, one that completed
across chunks aliases the decoder's own buffer. Either way they are valid only
until the next `push`, the same rule as `TerminalBytes` in `@janela/pty`. Consume
or copy before pushing again. `validateHeader` runs the moment the fifth byte is
available and *before* any buffer is grown, so an over-long claim is an error,
never an allocation. A decoder that has thrown is finished; discard it with the
connection.

### FrameError

Every failure here is fatal to the *connection* and to nothing else. A daemon
that died because one client sent nonsense would take the user's terminals with
it.

`FrameError` is a `Data.TaggedError` carrying a tagged `reason`, which is the
shape Effect's own `catchReason`/`catchReasons` are built for. Each reason is a
`Data.TaggedClass` whose tag is the string the old `detail.kind` used, so log
output did not move:

| Reason class | Tag | Means |
| --- | --- | --- |
| `PayloadTooLarge` | `payloadTooLarge` | `length` exceeded `MAXIMUM_PAYLOAD_LENGTH` |
| `UnknownFrameKind` | `unknownKind` | the `kind` byte is not one we know |
| `TruncatedFrame` | `truncated` | the peer went away mid-frame |
| `RawHeaderTooShort` | `rawHeaderTooShort` | a raw payload is shorter than `RAW_HEADER_LENGTH` |
| `UnexpectedFrameKind` | `unexpectedKind` | a direction violation, or a caller bug on this side |
| `MalformedControl` | `malformedControl` | not UTF-8 JSON, or a `type` outside the union |
| `UnknownTerminalFrame` | `unknownTerminal` | a raw frame named a terminal this side does not hold |

`unknownKind` is not forward-compatible on purpose: a peer speaking a kind we do
not know has failed the handshake's job. `malformedControl` deliberately carries
no text — the payload is peer-supplied and this package does not decide what is
safe to log. `unknownTerminal` is raised by the *receiver* — the daemon's accept
loop, the client's mirror — never by the decoder, which has no table to look in;
close the connection and log the id, and never create the terminal it names.

Branch on a reason with `Match.tag`, `Effect.catchTag` or `Predicate.isTagged`,
never by reading `_tag`. `frameErrorLabel(error)` returns the tag as a string for
a log field.

## message-coder.ts

Free functions rather than methods on the message types, because the encoding is
a property of the *protocol version*, not of the message. When version 2 encodes
control frames differently, this is the only place that changes.

### Control frames are validated to the discriminant, and no further

`decodeClientMessage` and `decodeDaemonMessage` decode the payload as JSON and
check `type` against a `Schema.Literals` of that union's discriminants. They do
not validate fields.

That split is deliberate and load-bearing. Field validation belongs to the
request dispatcher, which has to answer a malformed request with a `failed` reply
rather than by closing the connection; a coder that validated fields would turn
every bad field into a dropped socket. What the coder *does* enforce is that
`{"type":"input"}` is rejected, because `input` is in neither union — keeping
terminal traffic out of the control path is the whole reason it is not in
`ClientMessage`.

The discriminant tables are built with `exhaustiveLiterals<ClientMessage["type"]>()`,
which fails to compile if a member of the union has no entry, and fails to
compile if an entry is not a member. A new message that nobody adds here is a
compile error, not a silently undecodable frame.

### Raw frames

`Input` and `Output` payloads begin with a fixed 16-byte big-endian UUID header,
encoded here so both sides agree in one place. The id is a UUID rather than a
small integer handle: a handle would need a per-connection table on both sides, a
lifecycle, and a class of bug where the two sides disagree about what handle 3
means. The id is already the thing every other message names. Measured in the
migration spikes, a coalesced repaint is typically 140 bytes to a few KB, so 16
bytes is under 10% on the small end; a handle would save 12 of those bytes.
Putting the id inside JSON would inflate the hot path by a third and add two
passes per frame.

`HEX_PAIRS` is built once at module load: `readTerminalID` runs once per raw
frame per attached client, and `toString(16).padStart(2, "0")` per byte would be
16 string allocations on the hot path instead of a lookup. `notAUUID` is a
function so the template is not built on the success path — `writeTerminalID`
runs once per keystroke and once per repaint. Both walk the string with
`charCodeAt` rather than splitting or matching it: no intermediate strings, no
array, nothing proportional to anything.

`writeTerminalID` throws `TypeError` for a non-canonical id. That is a caller
bug, not a protocol error — ids reach this side already validated by
`identifier()` — and the id is safe to name in the message, because an id is not
private data.

`decodeRaw` returns a view into the frame's payload rather than a copy: it runs
once per frame per attached client. Its only allocations are the id string and
two small objects, none proportional to the payload. Decoding is **total**: any
16 bytes are some terminal id, so it never throws for an id it has not seen,
because it has no way to know. The receiver must look the id up and raise
`UnknownTerminalFrame` on a miss.

## message.ts

Keyboard input is deliberately absent from `ClientMessage`, and terminal output
from `DaemonMessage`: both are the hot path and travel as raw frames.

`StateUpdate` carries whole objects rather than diffs. The data is kilobytes, and
a diff protocol for the sidebar would be a lot of machinery to save nothing —
and merge-by-id cannot express a removal.

`SessionCreationIntent` mirrors `@janela/session`'s own request type rather than
sharing it, for the same reason `SessionRemovalPreview` does: the shape is frozen
by the protocol version, and letting a daemon package define it would make one of
its refactors a breaking change for someone's script.

`subscribe` is scoped so a CLI listing sessions does not subscribe to terminal
output it will never render. `attach` does not start anything — that would make
opening a session spawn processes.

## handshake.ts

The first frame on every connection, in both directions. Nothing else is accepted
until it is exchanged. The daemon may be older or newer than the client; after an
app update it is routinely older, and it is holding the user's live terminals
while being so. `isCompatible` is symmetric and deliberately not "the versions
are equal".

`Hello.credential` is unused over the local socket, where the OS vouches for the
peer by uid — stronger than anything we would invent. It is present from v1
because adding a field to a shipped protocol is a breaking change and this one
costs nothing to carry. A network transport must populate it, and must not be
allowed to reuse "the OS vouched for the peer".

Refusal never terminates the daemon or its terminals. The client explains the
situation and offers a restart.

### Version history

There is no minor version: a change is either compatible, in which case it needs
no number, or it is not.

| Version | Change |
| --- | --- |
| 1 | Scaffold: framing and JSON control messages. Raw frames had no defined encoding at all, so nothing ever spoke it. |
| 2 | `Input`/`Output` payloads begin with a 16-byte big-endian UUID header; `FrameDecoder.end()` reports a stream that closed mid-frame. |
| 3 | `removalPlan` joins `ClientMessage`; `attach.viewport` becomes optional, meaning input and scope without rendering; every state announcement is a full snapshot, because merge-by-id cannot express a removal; `saveLaunchProfile`, `removeLaunchProfile` and `createTerminal` join it too, and `StateUpdate` carries the launch profiles with their availability. |
| 4 | `createTerminal.placement` (a split, persisted by the daemon), and `removeTerminal` and `restartTerminal` join `ClientMessage`. |
| 5 | A repaint carries the negotiated grid: `fullRepaint` emits `CSI 8 ; rows ; cols t` between its RIS and the screen, and a client is re-sent one whenever the negotiation moves or overrules its viewport. The size travels in the raw output frame rather than as a control message because it belongs to the same ordered stream as the bytes it describes — a size arriving out of band would paint one geometry's screen into another's grid. |
| 6 | `projectBranches` and `moveTab` join `ClientMessage`, and `SessionCreationIntent`'s `inProject` case gains an optional `branch` to check out in the project's own directory. |
| 7 | `SessionCreationIntent`'s `newWorktree` case gains `shareBranch`, which asks the daemon for `git worktree add --force` so a branch already checked out somewhere can have a second worktree; its `name` now also names the directory the daemon places that worktree in, which is what keeps two worktrees of one branch off the same path. |
| 8 | `listDirectory` joins `ClientMessage`: a client that has no folder picker of its own — a browser page — asks the daemon to read one folder of the Mac's filesystem, and gets a `DirectoryListing` back as `text`. |
| 9 | `moveTerminal` joins `ClientMessage`: a terminal pane leaves its place in the layout and docks beside another pane (`beside`, at one of four edges), at the right of a whole tab (`tab`), or in a new tab of its own (`newTab`). The daemon applies it and persists the result, so every client mirrors the drop. |
| 10 | `ProjectSettings` changed shape on the wire: `automation` is a script per event (`AutomationScripts`, keyed by `AutomationEvent`) instead of a list of `AutomationCommand` argv rows, each script carrying its own timeout. `updateProjectSettings` is the one message that carries it, and a peer of either age would read the other's `automation` as the wrong kind of thing entirely — a list where a record belongs, or the reverse. |
| 11 | `integrations`, `installIntegration` and `removeIntegration` join `ClientMessage`: a client asks what Janela's activity-reporting hooks look like in each harness's own configuration, and asks for one to be installed or removed. `AttentionKind` gains `activity`, and `TerminalState` carries an `AgentActivity` on both `running` and `needsAttention`, so a harness that says what it is doing reaches the sidebar and the notification policy. |
| 12 | `ProjectSettings` lost `defaultProfileID`, and the global settings lost theirs: every new terminal — a session's first included — starts the login shell. `updateProjectSettings` carries the smaller shape; a v11 client would keep sending a field the daemon no longer stores, and a v11 daemon would keep honouring one the client can no longer set, so the two would silently disagree about what a new session opens. |

`MINIMUM_SUPPORTED_VERSION` is 12: it moved with the version, as it did up to 6 and again at 8 through 11 — a v10 daemon's discriminant table does not know `integrations`, and the first client that opened the Integrations tab would close its connection; a v10 *client* would not know the `activity` attention kind either. New discriminants are exactly the change the tables refuse, so the handshake refuses instead. Version 12 is the rule of 10 again: a message both sides decode, carrying a shape they would read differently.

A v5 peer does not degrade, it *disconnects*: its `decodeClientMessage` matches
the discriminant against an exhaustive table and refuses anything absent from it,
and the daemon's read loop turns that into a closed connection rather than a
`failed` reply. The strictness is deliberate — it is what keeps terminal traffic
out of the control path — so a v6 client meeting a v5 daemon would lose its
connection the moment a user opened the new-session dialog, with no reply to
correlate and no explanation. A refusal a person can read beats a socket that
drops on a menu click.

v7 against v6 *does* degrade: v7 only adds optional fields to a message a v6 peer
already decodes, so the one affected request reaches git without `--force` and
comes back as git's own refusal. A shared-branch worktree the user does not get
is a worse answer, not a lost connection, and refusing the handshake instead
would take the user's live terminals off them to prevent it.

A v5 peer's `hello` is answered with `refused` / `incompatibleVersion` carrying
this range; the daemon keeps running and no terminal is touched. A v6 client
meeting a v5 daemon refuses on its own side and tells the skew story — "the
background service is older", whose only button is "Restart the background
service" — rather than reporting a handshake failure. Nothing after `hello` is
decoded from a refused peer.

v8, v9 and v11 are new discriminants again, so the rule of v6 applies: a v7
daemon meeting a v8 client would close the socket the moment a browser user
pressed ⌘O, a v8 daemon meeting a v9 client the moment a pane was dropped, and a
v10 daemon meeting a v11 client the moment the Integrations tab asked what is
installed, with no reply to correlate. v10 is the other shape — a *field* that
changed meaning, `ProjectSettings.automation` — which the discriminant check
cannot catch at all: both peers decode `updateProjectSettings` happily and then
disagree about what `automation` is, which is worse than a closed socket and is
why that one moved the minimum too. Refusing the handshake instead costs the
user one restart of the background service — which the skew banner offers, and
which never touches a terminal.

`TerminalState.running` gained an optional `progress` field **without a version
bump**, and by the rule at the top of this section that is what compatible means.
It is v7's case exactly: an optional field inside a message both peers already
decode, and only the `type` discriminant is schema-checked in `message-coder.ts`,
so a v9 peer that predates the field ignores it and shows a plain "running"
terminal — the progress bar is the thing it does not get, not the connection.
`attention` and `terminalExited` needed nothing at all: both were already in the
v9 discriminant table.

`TerminalState`'s `activity` is the same *kind* of field and would have needed no
bump either — a v10 client ignoring it shows a plain "running" terminal. v11
exists for the three new requests and for `AttentionKind`'s new `activity` case,
which is a discriminant inside a message and therefore the one thing an older
client's own `Match` over attention kinds is not prepared for.

## removal-plan.ts, branch-overview.ts, directory-listing.ts

All three are wire mirrors of daemon-side types (`SessionRemovalPlan` and
`DirectoryListing` in `@janela/session`, `GitWorktree` in `@janela/git`),
mirrored rather than shared because the shape is frozen by the protocol version
and this package may not depend on the daemon side at all.

They travel as the `text` reply to a request rather than as their own
`DaemonMessage`, because a reply has to be correlated by `RequestID` and the
three reply variants are what a client's `request()` settles on.

The `serialize*` functions copy field by field, so a caller's wider object — the
daemon passes its own structurally-wider type — contributes nothing but the wire
fields. The `parse*` functions decode with `Schema.fromJsonString`, which
rejects non-JSON, a non-object, a missing field and a wrong-typed field alike,
and strips anything extra. Failure is a `TypeError`: a peer that sends a plan
with a string count is not speaking this protocol, and a half-checked plan is how
"delete the directory" becomes undefined.

`BranchOverview` carries both a branch list and a worktree list rather than a
map, because a worktree may be detached and therefore name no branch, and a
branch may be checked out nowhere. A map would have to invent a key for the first
and lose the second. A detached worktree's `branch` key is **omitted**, not set
to null — `exactOptionalPropertyTypes` makes the distinction load-bearing on the
way back in, and `Schema.optionalKey` preserves it in both directions.

`worktree.directory` is validated as absolute by the schema and then branded
through `absolutePath()`, which is the one place that decides what an absolute
path is. It becomes a session's working directory, so a half-checked overview is
how "check this branch out here" becomes a session pointing at `undefined`.

`DirectoryListing` names the folder it lists, its parent (omitted at `/`, the
same `optionalKey` discipline as a detached worktree's branch), the daemon's home
so a client can offer it without a second request, and a `truncated` flag: the
daemon never sends more than `DIRECTORY_ENTRY_LIMIT` entries, and the client
says so rather than pretending the folder ends there. Every path is validated
absolute and branded, because the one a client chooses becomes a session's
working directory or a project's root. Entries carry a name and one of two
kinds; a symlink already took its target's kind on the daemon, so the wire has
no third one.

## transport.ts

`MessageTransport` is the one abstraction that makes a remote client possible
without redesigning the protocol, and the only speculative generality in this
layer. It is a cost rather than a free option — every implementation pays for the
indirection — and what it buys is a client that is not on this machine.

In v1 there are two implementations and both are local: the daemon's Unix socket
listener, and the desktop app's bridge through Tauri's IPC, because a WebView
cannot open a Unix socket so the Rust shell does it and relays frames.

`incoming()` finishes when the peer disconnects cleanly and throws when it does
not. Both are ordinary outcomes: a client quitting is not an error, and a client
crashing is not fatal to anyone else. `send()`'s back-pressure is the
implementation's business and **must be bounded** — a stalled peer may not grow a
queue without limit, and dropping *coalesced repaints* is safe in a way dropping
terminal input never is. See `docs/performance.md` § Terminal throughput and
`BoundedQueue` in `@janela/support`.
