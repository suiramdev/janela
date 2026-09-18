# @janela/terminal

Layer 4, daemon side. Owns `LiveTerminal`, the authoritative grid, damage
tracking and repaint encoding. It runs in `janelad` and never in a client; the
client's half of the same seam is `@janela/terminal-ui`, which draws.

**It must not be imported *through*.** No emulator type leaks upward: `index.ts`
exports the `createEmulator` factory, never `HeadlessEmulator`, and
`@xterm/headless` plus `@xterm/addon-serialize` are gated to this package by
`scripts/layers.ts`. Everything above talks to `TerminalEmulating`.

The grid is authoritative here rather than in the client because a client is a
renderer of a mirror (AGENTS.md non-negotiable 6), and because scrollback then
costs one copy however many clients are attached: two windows on one terminal are
one grid and two render surfaces. It is also what makes reattaching *correct*
rather than lucky — see `docs/architecture.md` § Terminal data flow.

Almost all of this package is the terminal byte path, which
`docs/architecture.md` § "Effect at the seams" places deliberately out of scope
for Effect. `Schema`, `Match` and `Effect.try` appear only where something is a
lifetime or a parse, never per byte, per frame or per cell. The budgets that
decide this are `docs/performance.md` § "Terminal throughput" and § Interaction
("keystroke → glyph on screen: 1 frame").

## terminal-emulating.ts

The seam: feed bytes, resize, ask for damage since a revision, serialise the grid
for a newly-attached client, snapshot text. Backed by `@xterm/headless` today. The
cost of finding out later that it should not be is exactly the size of this
interface, so it stays small — a capability that wants to name the library belongs
here instead.

One property changed with the daemon and is worth stating plainly: the daemon and
the client no longer run the *same* library, only the same family. The protocol
ships escape sequences, so the two need agree on VT semantics rather than on an
internal format — "they cannot disagree because they are the same code" has become
"they should not disagree".

`feed` is called at most once per frame with a coalesced chunk, and chunk size is
not a detail: measured against `@xterm/headless`, 8 KB writes sustain ~6 MB/s and
1 MB writes ~140 MB/s. The throughput budget is met by *how* this is called as
much as by what implements it.

`revision` is the handle for damage tracking — a client that last saw revision N
asks what changed since N. Reading it is polled once per frame per attached
client, so it must not be a synchronisation point.

`repaintSince` and `fullRepaint` return **views into a buffer the implementation
reuses**, valid only until the next call that touches the same emulator. The frame
loop copies synchronously when it encodes the frame; anything holding one longer
must copy first. Same rule as `TerminalBytes` in `@janela/pty` and as
`frameDecoder`'s frames in `@janela/protocol`.

A full repaint is always a valid answer to `repaintSince`, and that is deliberate:
the hard optimisation can only ever make us slower, never wrong. It is the
*correct* answer to a resize, an alternate-screen switch, a `RIS`, a client
claiming a revision from the future, and a client further behind than the
implementation can express — answering one of those with a delta would be a guess.

`snapshotText` is what makes a CLI useful to an agent: "what is on screen in the
build terminal" is a protocol request rather than a screen-scrape. It may be
expensive; it is never called per frame.

`TerminalEventSink` is deliberately short and deliberately *mechanical*. Every
entry corresponds to a real escape sequence or a real process event. There is no
`agentIsThinking`, because no terminal sequence means that. `onAttention` arrives
per *terminal*, not per session — a session's badge is derived from its panes —
and whether it also becomes a notification is policy, which lives in
`@janela/client` because only a client knows what is focused. `onWorkingDirectory`
needs shell integration the user may not have; absence is normal and no feature
may block on it.

`DEFAULT_SCROLLBACK` is 10 000 lines. Scrollback is bounded by `@xterm/headless`'s
own ring buffer, sized by this number, which is how non-negotiable 9 is satisfied
for the largest accumulator in the daemon. It is passed by the caller rather than
defaulted inside `createEmulator`, because an unbounded ring buffer is the most
obvious way to violate that rule and a default that hides the decision helps
nobody.

`MAX_OSC_TEXT_LENGTH` is 1024. xterm bounds an OSC payload at 10 MB; nothing above
this package needs more than a line of one, and a client badge, a sidebar entry or
a log record is exactly where an unbounded string would land. Non-negotiable 9
applies to strings too.

## osc.ts

OSC payload parsers, pure and separate from the emulator so they are testable
without a grid and so the emulator's OSC handlers stay two lines each.

Everything here reads a string a *child process* chose. It is an untrusted
boundary, and every function refuses rather than guesses: an unparseable payload
is `undefined` and the sequence is dropped — never an error, never a
half-understood value. A wrong working directory in a session header is worse than
an absent one.

These are **not** `Schema` decodes, and that is a decision rather than an
omission. Nothing here is JSON or a persisted record: an OSC 7 payload is a URL,
and OSC 133 / OSC 777 are positional `;`-separated fields whose parse *is* the
split. What `Schema` would add is a decode of a shape that has no shape. The two
places a standard API throws instead of refusing — `new URL` and
`decodeURIComponent` — are lifted once at module load with
`Option.liftThrowable`, so the absence is a value rather than a caught exception.
That costs one `Option` per OSC sequence, which arrives per prompt or per
notification, not per byte.

**A notification body is never logged** (AGENTS.md non-negotiable 11,
`docs/conventions.md` § Logging). OSC 9/777 payloads are the user's own program
talking; they reach `AttentionDelivering` and nowhere else, and this package holds
no logger on that path at all. `live-terminal.test.ts` asserts it end to end:
a real child emits an OSC 9 with a recognisable body and the recording logger
never sees it.

`parseWorkingDirectory` accepts only this machine's paths. A shell on the far side
of an `ssh` session reports a directory that does not exist here, and showing it
would make a session header confidently wrong. WHATWG normalises
`file://localhost/` to an empty host, so both spellings of "here" arrive as `""`.
It *rejects* an over-long path where the other parsers truncate, because a
truncated path is a wrong path.

`parseNotification` ignores `OSC 9 ; <digits> ; …`. ConEmu also uses OSC 9 for
sub-commands, of which `9 ; 4 ; …` is a progress bar; treating those as
notifications would badge a session once per percent of a download.

`parseProgress` reads the one sub-command that has a meaning here, `9 ; 4`. The
state field is ConEmu's: `0` clears, `1` is `normal`, `2` is `error`, `3` is
`indeterminate`, `4` is `warning`. A percent accompanies the three determinate
states, is clamped to 0–100 and defaults to `0` when it is absent or empty —
a program that says `error` without a number has still said `error`, and
refusing the whole report over a missing field would lose the part it got right.
Anything else is malformed and returns `undefined`: an unknown state, a
non-integer percent. `cleared` is a report in its own right rather than an
absence, because "the download finished" and "this program never had a progress
bar" are different facts and only one of them should erase a bar already on
screen. Plain `OSC 9 ; <text>` is untouched by all of this and stays a
notification — the split is decided by whether the first field is a bare
sub-command number, which is why the two parsers can disagree about the same
sequence without either being wrong.

**Agent activity, `OSC 7770`, is not parsed here.** Its codec lives in
`@janela/core` (`agent-activity.ts`) because three layers must agree on the
spelling: the hook `@janela/integrations` writes into a harness's own
configuration, the emulator that reads it back, and the client that renders it.
A parser in this package would make the daemon the only place that knows the
grammar, and the hook would drift from it silently. `headless-emulator.ts`
registers `AGENT_ACTIVITY_OSC` beside 9, 777 and 133 and hands the payload to
`parseAgentActivity`; a payload that is not one of `working`,
`waiting;permission`, `waiting;input`, `finished;completed`,
`finished;failed` reports nothing. Either way the handler returns `true`, so the
sequence is consumed and **the grid is untouched** — a harness saying what it is
doing must never print a stray character into the user's screen.
`headless-emulator.test.ts` feeds a real escape and a bogus one and asserts both
the single report and an unchanged snapshot.

This is the same shape as `OSC 9;4`: the program *says* what it is doing. Janela
never reads a harness's output for meaning (non-negotiable 3), so an agent's
state comes from a hook the user chose to install, not from pattern-matching
prose.

`parsePromptMark` returns only the three marks Janela acts on. `B` (end of
prompt) and kitty's `P` property extension are perfectly valid and simply carry
nothing this layer can use, so they are ignored rather than treated as malformed.

`sanitiseOscText` truncates by code point rather than by code unit, so a payload
ending in an emoji does not leave a lone surrogate behind to render as a
replacement character in someone's sidebar. The length bound is the load-bearing
half: xterm's parser already refuses most controls inside an OSC string, but it
will happily hand over megabytes.

## headless-emulator.ts

`TerminalEmulating` over `@xterm/headless`, and the only module in the daemon half
that names an emulator library.

### Why it reaches past the library's public API

Damage tracking. The library knows which rows a chunk touched — it has to, to
repaint a canvas — and asking it is the difference between a delta and a screen.
What it hands over is a *conservative* range: its own tracker marks the whole
scroll region on every scroll and both cursor rows on every cursor move, so a
tracker-only encoder re-sends most of the screen when a TUI moves its cursor one
cell. The range is therefore a bound on **where to look**, and a shadow copy of
the packed cell words decides what actually changed.

`libraryInternals` validates every internal once, at construction, and each check
throws naming the member that moved. A library bump must not turn into a silently
wrong grid — a shadow diff against a buffer that is no longer the active one, or a
combined character read from a field that stopped existing.
`onRequestRefreshRows` is the one exception: without it the encoder diffs every
row on every chunk, which is slower and just as correct, so its absence *degrades*
rather than throwing. `headless-emulator.test.ts` covers both halves — one test
asserts the hint is still there, and another round-trips the fallback.

`_core`, `_inputHandler` and `_data` keep the library's own names. Renaming them
would only hide which member is meant, which is why `no-underscore-dangle` is
disabled in that one file with its reason attached.

### What the shadow grid and the revision ring buy

`shadow` holds the cells the grid last agreed with, row-major, three packed words
per cell. `syncRow` compares word-wise rather than cell-wise through the public
API: three integer comparisons per cell, no allocation, and an early exit on the
first difference.

A cell whose packed word carries the combined-character flag is always treated as
changed, because the string lives *beside* the row and a changed combined
character does not change the word.

`changedAt[y]` is the revision at which row `y` last changed, and it is shifted
with the rows on every screen scroll — so "the rows with `changedAt[y] > n`" is
exactly the set a client at revision `n` still needs after it has scrolled its own
screen. A row whose content moved under an older revision number would otherwise
never be sent, and the client would keep a stale line for as long as it stayed on
screen. It is a `Float64Array` rather than a `Uint32Array` because a daemon can
outlive 2³² revisions and a wrapped counter would answer "nothing changed".

`SCROLL_RING` is 128 revisions of scroll history — one word each, which bounds the
memory, and a second of continuous scrolling at 120 Hz. A client further behind
than that gets a full repaint, which is what the frame loop owes a stalled client
anyway. It is a judgement value; change it only with a measurement.

A row that scrolled *in* is adopted without being diffed: the client's own scroll
moved something else into that position, so the comparison could only ever answer
"changed". Under a flood that is the whole screen, every frame — which is the
point, because the wire cost then tracks the grid rather than the throughput.

### `feed` parses synchronously, and that is asserted

`TerminalBytes` is a view into a buffer `@janela/pty` reuses every frame, so the
bytes are gone by the next drain. `Terminal.write` is normally *asynchronous* — it
queues the chunk and parses it from a `setTimeout(0)` — which would hand the
parser someone else's output. The escape hatch is xterm's own: a write buffer that
has just seen user input parses the next chunk inline, so a keystroke's echo is
never a frame late. `input("", true)` sets exactly that flag through the public API
and writes nothing, and the flag is cleared by each inner write, so it is set per
chunk rather than once.

The alternative — copying every chunk — is up to a megabyte of allocation per
terminal per frame, which is the throughput budget spent on nothing. So the
assumption is asserted rather than trusted: a future version that queues the write
anyway throws here instead of silently parsing recycled memory. The test feeds a
buffer and then overwrites it.

Every non-empty chunk bumps the revision, including one that only carried a title:
the daemon cannot know what a chunk did before it is parsed. A bump with no damage
behind it costs a client one length-zero answer, and `repaintSince` returns the
one shared `EMPTY` view for it — "nothing changed" is the common case and must not
allocate.

Every OSC and CSI handler is synchronous and the CSI ones return `false`, which is
the documented way to observe a sequence and still let the library act on it. A
handler returning `true` would be *replacing* the implementation and the grid
would stop matching the modes; a handler returning a promise would suspend the
parser and break the synchronous-parse requirement above. The handlers exist
because three pieces of state a client must mirror are not on `terminal.modes`:
cursor visibility, mouse encoding and cursor style.

`logLevel: "off"` is not tidiness. The default is `info` and it writes to
`console`; a daemon parsing a user's terminal output must not narrate it to the
system log. `allowProposedApi: true` is what `registerOscHandler` needs.

A delta may only scroll the client's screen while the scroll region is the whole
screen, because our own `\n` would otherwise scroll the client's *region*. A chunk
that touched `DECSTBM` falls back to plain row repaints — slower, and the only
correct answer.

### `fullRepaint` and `CSI 8 ; rows ; cols t`

`ESC c` (RIS) prefixes every full repaint. `SerializeAddon` writes for a *fresh*
terminal: relative cursor moves, `\r\n` row separators, and mode sequences it only
ever *sets*. Replayed onto a renderer that already has content — the second
repaint of any session — the result diverges from the source. RIS rebuilds the
receiver's buffers, returns it to the normal screen and resets modes and
attributes, which makes the replay grid-, cursor-, buffer- and mode-identical.

**The size announcement sits between the reset and the screen** (protocol 5 — see
`docs/packages/protocol.md` § Version history). It travels in the raw output frame
rather than as a control message because it belongs to the same ordered stream as
the bytes it describes: a size arriving out of band would paint one geometry's
screen into another's grid. It goes *after* RIS because RIS does not resize, and
*before* the content for the obvious reason. It reports what xterm holds after its
own clamp, so the report and the PTY can never disagree. An implementation that
drops it renders every line at the wrong wrap column and reports no error.

A receiver acts on parameter 8 only with `windowOptions.setWinSizeChars` enabled:
the library gates it on that flag and then implements no case for it, so the client
supplies the resize itself. `@janela/terminal-ui`'s `xtermRendering` is that
client, and the round-trip test's receiver mirrors it — keep the two in step.

Three modes the serialiser does not emit are appended after the screen: cursor
visibility, mouse encoding and cursor style. Without them a client reattaching to
a `vim` session shows a cursor `vim` hid, and one reattaching to a mouse-driven
TUI reports coordinates in an encoding the program did not ask for.

Scrollback is **not** part of attaching. Serialising 10 000 lines cost 24 ms and
662 KB in the migration spike, against the 50 ms attach budget in
`docs/performance.md`, for history a client can neither scroll nor search yet. A
reattaching client starts with an empty scrollback, as tmux's does.

`fullRepaint` is allowed to allocate: it runs on attach and on resize, never per
frame.

### clearScrollback

`CSI 3 J` goes through `feed` rather than around it, which keeps it in band with
whatever output is already queued and bumps the revision — a mirror that is not
told the buffer changed keeps rendering a scrollback the daemon no longer has. The
visible rows do not move, so the delta a client gets is length zero.

Known limit: on the alternate screen this trims the alternate buffer, which has no
history, and the normal buffer keeps its own until the program exits. That is what
`CSI 3 J` means, and clearing a buffer the user cannot currently see would be the
surprising choice.

## repaint-encoder.ts

The bytes half of the damage encoder: rows and cursor in, escape sequences out.
Split from `HeadlessEmulator` because the two halves fail differently — damage
tracking is a question about the library's internals, this is a question about VT
semantics, and this half is testable by reading the bytes it wrote.

**Nothing here allocates after `reserve()`.** Everything is written into one buffer
reused for every frame of the emulator's life, and numbers and characters are
written byte by byte rather than through `String(n)` or a `TextEncoder`. That is
not premature: this runs once per frame per attached client, which is 360 times a
second at the scale target in `docs/performance.md`, and the frame loop copies the
returned view before the next call.

Three VT details drive the shape of the output, and each is a bug we would
otherwise ship:

- **Erased cells are not spaces.** A cell erased under `CSI 44 m` carries the
  background colour, and a client that received `CSI 3 C` (cursor forward) over it
  would keep whatever it had there. So a run of empty cells is always *erased* —
  background set, `CSI n X`, then `CSI n C` — and a row's tail is always an `EL`
  rather than an `ECH` of the run, because the client may hold content past the
  row's last written cell and a shorter line overwriting a longer one is the common
  case. `SerializeAddon` may skip all of this because it writes for a fresh
  receiver; a delta has no such luxury.
- **Insert mode and origin mode change what our own writes mean.** With `IRM` set,
  printing a row shifts the rest of it right; with `DECOM` set, `CUP` is relative
  to the scroll region. Both are neutralised before anything is painted and
  restored by `cursor()`, which is why that call is mandatory and must be last —
  `CSI ? 6 h` homes the cursor.
- **A cursor at column `cols` is a real state** (pending wrap), and neither `CUP`
  nor `CUF` can reach it: both clamp. The only way there is to print in the last
  column, so that is what `cursor()` does — and if that column is the second half
  of a wide character, the character is reprinted whole from the column before,
  because printing a space there would erase it.

`22` turns off bold *and* dim in every terminal, so wanting one of the two while
the other is on means `22` and then the one that is wanted. Emitting `22` for
either — which `SerializeAddon` does — silently drops the other. Both directions
are pinned by name in `repaint-encoder.test.ts`.

The mode line carries **both polarities, always**. A delta arrives at a client
whose modes are whatever its last delta left, so a client that once entered
bracketed-paste mode has to be told it is over. Mouse tracking is one of four
exclusive modes and a client may hold any of them, so all four are cleared before
the one that is on is set; mouse encoding likewise.

A default-background cell reports colour −1 while `CSI 49 m` leaves 0. Normalising
the default to 0 keeps the tracked state comparable with what the reset sequence
leaves behind, so a row of untouched cells emits no colour sequence at all. Compare
the two raw and every blank row pays for a colour it already has.

`scrollUp` is a `CUP` to the last row followed by line feeds — the only sequence
that both scrolls and *keeps* the lines that leave the screen. `CSI S` (SU)
discards them, and a client that lost them has a scrollback the daemon's disagrees
with. It is correct only while the scroll region is the whole screen, which is the
caller's guard, not this one's.

A combined cell keeps its *index* in the packed word and its string in the row's
table, so the string is read through `combinedData` and encoded from its UTF-16
units — `getCode()` would return the last codepoint of the string, the accent
alone. Anything else is one codepoint, which is the common case and never touches a
string.

Extended attributes (underline style and colour, hyperlinks) are not reproduced.
That is parity with `fullRepaint`, whose serialiser does not emit them either, and
not a gap this encoder introduces.

The bound — `rows × (cols × MAX_CELL_BYTES + ROW_OVERHEAD_BYTES)` plus a frame's
overhead — is what makes overflow a programming error rather than a possibility.
`MAX_CELL_BYTES` is 64: truecolor foreground and background, every flag on, and a
four-byte codepoint measured at 62 bytes against the longest sequence
`writeCellAttributes` can emit. Past the bound `end()` returns `undefined` and the
caller answers with a full repaint, because a truncated delta is the one thing
worse than a slow one — it leaves the client's grid quietly incorrect with nothing
to notice. Reaching the bound means the bound or the per-cell worst case is wrong,
which is a bug to find rather than a stream to corrupt.

The initial allocation is 64 KB and grows at most once, to the bound. A 200×60
grid's bound is 800 KB, which nobody needs up front.

## live-terminal.ts

A PTY, a child process, and the authoritative screen.

`LiveTerminal` rather than `Terminal` because `TerminalDescriptor` is the
persistable one and this is the running counterpart — and because emulator
libraries export a `Terminal` of their own, so the collision would be resolved by
whoever imported last.

**`start()`, not the constructor, is what allocates.** Constructing one costs no
PTY, no process and no emulator, which is what makes 40 configured terminals
viable, why `idle` is a first-class `TerminalState`, and how the `< 100 KB per
idle terminal` and `< 8 MB per live terminal` rows in `docs/performance.md`
§ Memory are met. AGENTS.md non-negotiable 5 is the product version of the same
statement.

Two things it deliberately does not do, both tempting:

- **It does not drain per attached client.** One drain, one feed, N encodes.
  `drain()` is separate from `repaintFor()` for exactly that reason, and it runs
  for terminals nobody is watching: a detached terminal has to keep consuming or
  its child blocks in `write(2)` at the high-water mark, and "your terminals
  survive the window closing" would be a lie.
- **It does not treat a missing client revision as "everything".** A client's
  first frame is whatever changed since it attached; the whole grid is
  `fullRepaintFor`, explicitly. A sentinel here is how a routine frame becomes a
  full-screen redraw.

`state` is derived, never stored: two sources of truth for the thing the sidebar is
judged on would be one too many.

`send` goes straight to the PTY with no interpretation. Janela implements no key
bindings the terminal should own (non-negotiable 4), and a client that
pre-processes input has made the same mistake one process further out. Ctrl-C
arrives here as the byte `0x03`, for the line discipline to interpret. Sending also
clears attention — the one mechanical "the user has seen it" signal the daemon has.

`stop()` hangs up and returns. The state stays `running` until `drain()` observes
the reaped status, which is the truth: a child may ignore `SIGHUP`, and a code
invented here would be a code no process ever produced. `restart()` does not await
the old child's status — its reader thread reaps it, and `start()` clears the exit
and failure it would have reported.

### `TerminalEvents`, and why the timing happens here

The emulator reports through `TerminalEventSink`; a `LiveTerminal` reports through
`TerminalEvents`, which extends it with the two things only a process has.
`onFailure` carries a read failure's summary — the emulator has no file
descriptor to lose. `onPromptFinished` carries a `PromptCompletion`: the seconds a
command ran, and its exit code when OSC 133 D supplied one.

The duration is measured **here**, between the `C` mark and the `D` mark, rather
than by whoever consumes it. The alternative — forwarding both marks and letting
the daemon subtract — would mean the daemon holding a start time per terminal, and
a `commandStartedAt` in two places is a `commandStartedAt` that disagrees across a
restart. Doing it here also keeps the layering honest: a completion is a number
and an optional code, both plain, so `@janela/terminal` never names a protocol
type to describe what finished. A `D` with no `C` before it — the first prompt
after attaching, a shell that emits marks unevenly — reports nothing rather than a
duration measured from a time nobody recorded.

**Progress does not survive the process that reported it.** `start()`, the read
failure path and the exit path each clear it, alongside `commandStartedAt`, so a
restarted terminal does not inherit the last run's 80% and an exited one does not
leave a bar on screen forever. `OSC 9 ; 4 ; 0` clears it the same way from the
other direction, which is a program saying it is done rather than a program
ending.

### What an activity report does to the state

`onActivity` stores the report and moves attention with it: `working` clears
attention, `waiting` and `finished` raise it. The harness is the authority on
whether it is blocked, so a report is allowed to *lower* the flag a previous
report raised — that is how a session stops glowing when the user answers a
permission prompt inside the agent rather than through Janela. Attention has one
flag, not one per source: a `working` report clears a bell that rang before it,
and a bell that rings after it raises attention again. The last event wins, in
arrival order, because a terminal either wants the user now or it does not.

`send()` and `fullRepaintFor()` keep clearing attention — the user typed, or
looked — but they **do not** clear the activity. "The user has seen it" and
"the agent is waiting for permission" are different facts: the sidebar stops
glowing while the row still says what the agent is doing. The activity therefore
rides on both live states: `needsAttention` carries it when attention is up, and
`running` carries it beside `progress` when it is not. Both are optional on the
wire, so a terminal that has never had a harness in it is byte-identical to
before.

Like progress, **an activity does not survive the process that reported it**:
`start()` clears it, so a restarted agent does not open already "finished".

### Size negotiation

`negotiatedSize` is the **minimum of all attached viewports**, which is tmux's rule
and the only one that guarantees no attached client is shown a screen it cannot
fit. A client attaching with no viewport — the CLI, reading text — does not
participate. It throws on an empty list rather than inventing an 80×24: "nobody is
attached" is `detach()` returning `undefined`, and a fabricated size here would
resize a running TUI to a screen no one asked for. `@janela/session` chooses the
pre-attach size instead, because it is the layer that knows.

Detaching the last client leaves the PTY at the size it had. Resizing a running TUI
because the last window closed would corrupt the screen the next client attaches
to.

`owesSize` is what makes the size announcement survive an encoder that only ever
sends deltas: it forces the full path, which is the only thing that carries
`CSI 8 t`. A resize invalidates a client's whole screen anyway, so a delta against
the old geometry would be meaningless even if one existed. The debt is set for
**every** attached client when the negotiation moves — the minimum is a fact about
the terminal, and the client that did not move is the one being letterboxed — and
also for a client whose vote was *overruled* without the negotiation moving at all.
Without that second case, a window resized while a smaller client holds the minimum
renders at its own width against the smaller PTY, permanently. That is the defect
`docs/survival-proof.md` § D2 recorded, and the reason `@janela/terminal-ui`'s
`letterboxMargins` has anything to work with.

### Where Effect is, and where it deliberately is not

`start()` and `applySize()` guard a synchronous throw, so neither runs an Effect:
the spawn and the `ioctl` are wrapped in `Result.try`, which catches into a
`Result` in place and starts no fiber. Both re-throw the original
`PseudoTerminalFailure`, because the `instanceof` contract in `@janela/support`
crosses the daemon/client decision and callers depend on it. A resize landing on a
child that died a frame ago is routine rather than a fault — the frame loop has not
observed the exit yet — so `notRunning` is the one detail `applySize` swallows,
branched with `Predicate.isTagged` and never by reading `_tag`.

These two sites were written first as
`Effect.runSync(Effect.result(Effect.try({ try, catch })))`, which was correct and
three layers deeper than the problem: there is no Effect program here, only one
synchronous call that may throw. `Result.try` is the construct that fits, and
`Result.try(fn)` with no `catch` puts the *original* thrown value in the failure
channel, which is exactly what a site that re-throws needs. `live-terminal.ts`
therefore imports no `Effect` at all — only `Predicate` and `Result`.

The one place `Effect` earns its keep in this package is a finalizer a `Result`
cannot express: `live-terminal.test.ts` installs a process-global signpost sink and
must restore it however the body ends, which is `Effect.acquireRelease` +
`Effect.scoped` run with `Effect.runPromise`.

`drain()` is the byte path and holds no Effect at all. `@janela/pty` used to signal
a lost descriptor by *throwing* from `drain()`, which would have forced either a
`try`/`catch` or a fiber per frame per live terminal — against
`docs/performance.md` § Terminal throughput and its "do not allocate per chunk on
the read path" rule. The seam was changed instead: `drain()` never throws, and a
latched `PseudoTerminal.readFailure` distinguishes a lost descriptor from plain
EOF. The happy path is one call and one subarray; `readFailure` is read only on the
`undefined` branch, a handful of frames per terminal lifetime, and returns an
object `@janela/pty` built once.

A lost descriptor is **not** a finished child. No `onExit` is emitted, because a
client told the child exited would show a status for a process whose fate nobody
knows; the terminal goes `failed` with the `UserFacingError`'s summary. `undefined`
with no read failure and no exit code yet is "gone but not reaped" — the next frame
asks again. **Both** end-of-stream paths clear `pty` and *keep* the emulator, so
the last screen stays readable and `repaintFor` takes the path it always did; the
emulator is disposed by the next `start()`. That is why a terminal recovering from
a drain failure adds no branch to the repaint path, and why `owesSize` is the only
thing that can turn a recovery frame into a full repaint from this side — see
`docs/packages/daemon.md` § frame-loop.ts for the daemon's half of that debt.

The log record on that path carries shapes only — a terminal id, an errno, an exit
status — and never a byte of what was on screen (non-negotiable 11). The absent
keys are omitted rather than set to `undefined`, because `exactOptionalPropertyTypes`
makes present-and-undefined a different type from absent and `LogRecord["fields"]`
admits no `undefined` value.

### Signposts

`begin("repaint", id)` runs once per frame per attached client and allocates
nothing without a sink installed — `@janela/support`'s `Signpost.begin` hands back
one shared no-op object and reads no clock. `repaintFor` and `fullRepaintFor`
therefore check `mark.observed` *before* building any fields. Do not change that
shape; a timeline entry per repaint is an unbounded buffer, which is why the module
does not call `performance.measure` itself. Budgets: `docs/performance.md`
§ "How to measure".

The `attach` interval is the daemon's half of the attach budget — from the request
to the bytes that carry the screen — and is closed by the first full repaint, or by
`detach()` if the client leaves before one, since otherwise the record would never
be written at all.

### Typed errors: why this package adds none

The playbook's closed-failure-set treatment does not apply here, and that is a
finding rather than an omission. Every failure this package can produce is one of
two kinds:

- **`@janela/pty`'s `PseudoTerminalFailure`**, forwarded unchanged. It is already a
  `UserFacingError` with a tagged `detail`, and this package branches on it with
  `instanceof` plus `Predicate.isTagged`.
- **A programming-error assertion** — registering a terminal id twice, asking for a
  repaint for a client that is not attached, `negotiatedSize([])`, a library
  internal that moved, a chunk the library parsed asynchronously. Each is a caller
  bug that deserves a stack trace, and no consumer branches on any of them:
  `packages/daemon/src/server.ts` *avoids* the unattached-client throw by
  construction rather than catching it. The precedent is `writeTerminalID` in
  `@janela/protocol`, which throws `TypeError` for the same reason. Tagging them
  would add discriminants nobody reads.

## registry.ts

Bookkeeping over live terminals, keyed by id: the single source of truth for "what
is running". `@janela/session` asks before it lets a worktree be removed, and the
daemon asks before deciding it may exit.

`inSession` is a filter, not an index. The scale target is 40 terminals
(`docs/performance.md` § Scale targets), and a second map to keep in step is a bug
surface bought with nothing. It spans every tab and split, which is what makes a
session's status derived rather than stored and what "closing a session kills its
terminals" means — including panes no client ever attached to.

`liveCount` counts terminals holding a process, which is `running` *or*
`needsAttention`: a terminal asking for attention is still running and the daemon
must not exit out from under it. The answer is computed here rather than taken from
`@janela/core`'s `isLive`, which is still unimplemented; switch to it when it lands,
because there must be one answer to this question rather than two. The daemon's
idle-exit rule depends on this number — a daemon with live terminals stays up with
no clients connected, and that asymmetry is the entire feature.

`register` refuses a second registration for an id. A restart keeps a terminal's
identity, so there is no legitimate second one, and replacing one silently would
orphan a live child. `remove` of something that was never there is a no-op, which
is how a teardown path stays simple.

`watch` installs **one** `TerminalRegistryObserving`, and registering a second
replaces the first. There is exactly one consumer — the daemon, wiring each
terminal's `events` as it appears — and a list would be a fan-out nobody asked
for, with a removal path to get wrong. Installing one **replays the terminals
already held**, so the observer sees a registry as it is rather than only what
happens next: the daemon calls `watch` during startup, after terminals may
already have been restored, and an observer that missed them would leave live
terminals reporting to nothing.

`hangUpAll` is called on `SIGTERM` at logout and on an explicit "Stop Background
Service". It is **never** called because a client disconnected (non-negotiable 7).
`stop()` on an idle or exited terminal is a no-op, so there is nothing to filter
and no state to consult first.

## throughput.bench.ts

The repaint budget, measured rather than asserted. Run by hand —
`bun run --cwd packages/terminal bench` — and deliberately **not** a `bun test`:
`bun test` runs files in parallel, so a 100 MB/s flood inside one measures the
machine's load rather than this code. The deterministic claims (a delta is at most
so many bytes, a quiet frame is empty, the returned view shares one buffer) are
asserted in `headless-emulator.test.ts`; the rate rows live here, where only a
human reads them.

It sits under `src/` rather than in a `bench/` directory because it drives
package-internal API — `HeadlessEmulator`, not `createEmulator` — and only `src/**`
is typechecked, so a change to the encoder's shape breaks the bench at `tsc` time
instead of the next time somebody runs it.

`FRAME_MS` is a literal rather than an import: `FRAME_INTERVAL_MS` lives in
`@janela/daemon`, which sits above this package and must stay that way. If the
frame loop's rate changes, this changes with it.

Five numbers per scenario, each guarding a different failure:

- **bytes/frame per client**, and the MB/s that implies on the wire at 120 fps.
  The socket budget is 2 MB/s.
- **encode µs/frame**, summed across three attached clients. A damage encoder that
  costs more CPU than it saves bytes is not a win.
- **feed µs/frame** and **CPU %** of the frame. Damage tracking is work done inside
  `feed`; this is where its cost shows.
- **feed MB/s** under a flood, reported and **not** gated. That row earned its
  place once — it caught the first version of the damage tracker diffing every row
  of a scrolling screen, a comparison that can only ever answer "changed" — but an
  interleaved A/B measured the *same* placeholder code at 121.9 then 166.8 MB/s at
  80×24, and 71.6 then 194.6 at 120×40. Under load it moves by a factor of three
  and would fail its own gate with no code change at all. The ≥ 100 MB/s budget was
  also measured off the PTY, not against the emulator's parse loop. Read it as a
  relative number: a low row means "re-run on a quiet machine, then A/B against the
  merge base", not "regression".

Only the wire row is gated, because it is byte-identical across runs.

It writes with `process.stdout.write` rather than `Bun.write(Bun.stdout, …)`: the
latter returns a promise, and unawaited writes interleave — a table printed that
way arrives with its rows shuffled and some rows missing. `.oxlintrc.json` has no
`*.bench.ts` override, so `no-console` applies here exactly as everywhere else;
nothing in this file uses `console`.

## Testing

`docs/testing.md` § "We do not fake the emulator when testing the repaint encoder"
is the rule, and the round-trip test is the single most valuable test in the
daemon, because everything else assumes the property it checks: feed bytes to one
emulator, encode the damage, feed the result to a second, and assert the grids
match — cell by cell, attributes included, plus the cursor and which buffer is
active.

The receiver is a **stock `@xterm/headless` terminal**, not a second
`HeadlessEmulator`, because a client renders with a stock emulator and that is the
thing that has to agree with us. It supplies `windowOptions.setWinSizeChars` and
its own parameter-8 handler, mirroring `xtermRendering` in
`@janela/terminal-ui` — the library gates `CSI 8 t` on that flag and then
implements no case for it.

Comparing byte strings would pin the encoder's mood instead of its contract, so
`repaint-encoder.test.ts` is the one file that asserts bytes: the difference
between `CSI 3 X` `CSI 3 C` and a bare `CSI 3 C` is invisible in a grid comparison
against a *fresh* receiver, and is exactly the bug that shows up on a real client
that already had content there. Every expectation there is named after the failure
it defends.

The adversarial cases each have a test, and each is a real defect class: successive
repaints onto an already-populated receiver (the reason RIS prefixes a full
repaint), alt-screen switches, wide characters at the last column and split by a
resize, scroll regions (no line feed while `DECSTBM` is set), a resize between
damage and encode, a client that missed several scrolling frames, the dirty-row
fallback, a flood whose delta must track the screen rather than the throughput, and
300 seeded random steps. The grid dump carries **every** attribute rather than a
selection: a dump that omitted `isDim` once let a delta leave the client's cell dim
when the source's was not, and the round trip could not see it.

`live-terminal.test.ts` spawns real children against real PTYs, for the same reason
`@janela/pty`'s own suite does — job control, `SIGWINCH` and a child's idea of its
own window size are exactly what a fake would paper over. Its `poll` helper runs on
a real clock and there is no version of it that does not: the thing under test is a
child process writing into a kernel PTY buffer, and `drain()` is what the frame
loop calls once per frame. What is avoided is the half that actually flakes —
nothing sleeps for a guessed duration and then asserts. Every wait is "drain until
this appears, or fail at a deadline", and the two negative claims ("no second
child", "no second close") are made against injected seams, where they are
decidable rather than merely unobserved.

A child whose output a test asserts on is also held open on a `read _` until the
test writes a newline, including the exit-status test: on Darwin the child's own
exit closes the last replica descriptor and the kernel flushes whatever the
reader thread has not copied yet, so the tail of a `/bin/echo` is a race and not
a contract (`docs/packages/pty.md` § Tests, where it is measured). The exit test
therefore releases the child *after* seeing its output, and asserts a non-zero
status — 7, which only a real `WEXITSTATUS` produces.

Two tests in `headless-emulator.test.ts` carry an explicit 30 s timeout: the
flood and the 300 seeded steps push roughly ten megabytes through two emulators
and dump a grid per step, so their wall time is the machine's and not this
code's. Neither asserts a duration — the flood's claims are that the delta stays
inside a byte budget, reuses one buffer and settles to a constant length — and a
loaded CI runner measured 5.1 s against `bun test`'s 5 s default, against 0.5 s
on an idle M4. A timing assertion would be the wrong fix for a size claim.

Two seams exist for tests and are worth keeping honest. The scripted
`PseudoTerminal` covers a read *failure*, which a real terminal cannot produce on
Darwin at all: a child exiting and `revoke(2)` on the replica both make `read`
return 0, which is EOF. The delta-only `TerminalEmulating` sends nothing unless it
was fed, which is what makes "who has been told the grid moved" decidable in
isolation — the production encoder answers a quiet screen with nothing too, but it
also answers a resize with a whole grid, so a bookkeeping bug would hide behind
that.
