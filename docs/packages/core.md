# @janela/core

Layer 1, the domain model: project, session, terminal, and pure functions over
them. No I/O, no frameworks, nothing platform-specific.

## index.ts

This is the vocabulary **both processes share**, so every type here crosses a
socket and must stay cheap to encode and free of anything process-specific. That
is why timestamps are ISO strings and paths are strings rather than `Date` and
`URL`.

Three nouns — project, session, terminal — and that is the whole concept budget.
`docs/product.md` § 1 explains why a fourth is expensive.

## accent.ts

One accent list, shared by `Project` and `Session`, because the sidebar shows
both and two parallel colour enums would drift the first time someone added a
colour.

Purely cosmetic, and that is the point: people navigate a list of thirty entries
by colour far faster than by name, and a colour costs nothing to learn. `"none"`
is a value rather than an absent field.

## agent-activity.ts

The spelling of what a harness says about itself, in the one place all three
layers reach: the hook `@janela/integrations` writes into a harness's own
configuration, the emulator in `@janela/terminal` that reads it back off the
byte stream, and the views that render it. Put the codec in the daemon and the
hook template would be guessing at the grammar the daemon happens to accept.

```text
ESC ] 7770 ; <payload> BEL

payload ∈ working | waiting;permission | waiting;input
        | finished;completed | finished;failed
```

`AGENT_ACTIVITY_OSC` is `7770`, named once and imported everywhere — the
emulator registers it beside 9, 777 and 133, and a second literal in a hook
template is how a channel stops working with nothing to grep for.
`formatAgentActivity` is the only place the payload words exist, and
`agentActivityEscape` is the only place the introducer and the BEL do; the
shell one-liner and both JavaScript templates build their strings from one or
the other rather than spelling `\x1b]7770` themselves.

`parseAgentActivity` is strict about the grammar and silent about everything
else: it returns `undefined` and never throws. A third field (`working;a;b`) is
rejected, a qualifier on `working` is rejected, `waiting` and `finished` are
rejected without a qualifier or with one outside their two values, and any
other first word is rejected. Nothing is trimmed, nothing is case-folded: this
payload is written by templates in this repository, so accepting `Working ` or
`WAITING;input` would only let a broken writer look correct in one direction
and fail in the other. An unrecognised payload is not something a user can act
on, so the emulator consumes the sequence, leaves the grid alone, and reports
nothing.

`agentActivityText` is the human sentence — "working", "waiting for
permission", "waiting for your answer", "finished", "stopped with an error". It
lives beside the grammar rather than in the views because a terminal's state
text and its tab badge (`model/tab-rows.ts` in `@janela/ui`) would otherwise
word the same fact twice. It is the only user-facing copy in the file.

## identifiers.ts

A branded string gives what a phantom type gave before: a `TerminalID` can never
be passed where a `SessionID` is expected. The model is three levels deep, every
level's id is a UUID underneath, and `sessionFor(id)` with the wrong `id` would
otherwise typecheck and return undefined forever. The brand is erased at runtime,
so these *are* strings: they encode to JSON as themselves and cross the socket
for free.

`Identifier<Subject>` stays a hand-applied brand rather than a `Schema.brand`
because it is **generic over its subject** and consumed that way — see
`packages/db/src/codec.ts`, which decodes a column into `Identifier<Subject>`
through the generic `identifier()`. A `Schema.brand` type is not generic over the
subject and would not fit. The four `as` assertions in this module are the brand
application sites, and each carries the checked invariant as a `SAFETY:` line.

`identifier()` is deliberately explicit and deliberately ugly: every call site is
a place where an untrusted string becomes a typed id, and those are worth being
able to grep for. The UUID pattern is case-insensitive on the way in, because a
row written by hand or by another tool is still a perfectly good id.

`AbsolutePath` is not a `URL`. Paths cross the socket, get compared for equality,
and are handed to `execve`; a URL round-trip through percent-encoding is a bug
waiting for the first directory with a space in it. A leading `/` is the whole
rule, and no `node:path`: this module is shared with the client bundle, where
that import does not belong, and Janela is macOS-first. Nothing is normalised — a
path that came from git or from `execve` is already the path the user's tools see,
and rewriting it would break the equality comparisons the sidebar depends on.

`Instant` is not a `Date`: a `Date` requires a revival pass on the far side that
one forgotten call site turns into a string masquerading as a Date. `instant()`
canonicalises to `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is what makes two Instants
describing the same moment compare equal as strings — a database round-trip
through `DATETIME` and an offset-bearing string from a forge must not produce two
different values for one timestamp.

## integration.ts

What a harness's activity-reporting hook looks like right now, as a value. The
package that reads and writes those hooks is daemon-side
(`@janela/integrations`); what crosses the socket to Settings is this, and it is
recomputed per request rather than stored — the user may edit
`~/.claude/settings.json` between two openings of the tab, and a cached answer
would be wrong precisely when it mattered.

`INTEGRATION_IDS` is a closed list of four — `claude`, `codex`, `opencode`,
`omp` — and `IntegrationID` is derived from it, so the protocol schema, the
daemon's validation (`isIntegrationID`) and the daemon's registry cannot drift
apart. `isIntegrationID` exists because an id arriving over the socket is an
untrusted string; the daemon rejects a bad one as a `TypeError`, like every
other malformed request.

`IntegrationStatus` has four cases and the interesting one is `unreadable`,
which carries a reason. A configuration file Janela cannot parse is not an
error to report and move on from: it is a file we must leave byte-for-byte
alone, and the only person who can fix it is the user — hence a status with a
reason, and a `configPath` in the report so they can go and look.

`IntegrationReport.isAvailable` is answered in the daemon, against the user's
real `PATH`, because this package has no I/O and a client cannot spawn a
process. A harness that is not installed still gets a row: the row is where the
user finds out that the hook they are about to install is for something they do
not have. `reports` is the list of things this harness will make Janela show —
user-facing copy, owned by the integration rather than by the view, because
what a hook can report differs per harness and a view guessing at it would be
the one place the two could disagree.

## project.ts

A project is a container *and* an index. It contains sessions — deleting a
project deletes them — and it indexes a repository so that "new branch" is one
step instead of a file picker.

Deliberately not modelled: nested projects, folders, tags (the sidebar is two
levels deep, always), and a separate `Repository` type. A project either has a
`git` descriptor or it does not; a plain folder is a perfectly good project that
simply cannot offer worktree-backed sessions.

`name` defaults to the directory name, is always editable, and is never required
to be unique — humans are bad at unique names and we do not need it.

`directory` is git's *main worktree*, not the common dir. Sessions backed by
`projectDirectory` run here; worktree-backed sessions are cut from here.

`isExpanded` is a boolean on a value because collapsing must do no work:
expanding a project may never trigger git, disk, or forge reads. See
`docs/performance.md` § Interaction.

`GitDescriptor` is **for display and for preselecting a sheet**. Git is always
the source of truth: we re-read rather than reconcile, because a cache that
disagrees with git is worse than no cache at all. `defaultBranch` is cached at
registration time so the "new branch" sheet can preselect without shelling out.
`forge` detection is a string match on the remote host, not a network call, and
whether the integration actually *works* additionally depends on the user having
`gh` or `glab` installed and logged in. We never hold a credential for either.
Absence of that binary on `PATH` means the feature is absent, not broken.

`ProjectSettings` earns its place because a project is where the differences
actually live: one repository needs `pnpm install`, another a Python venv, a
third neither. Per-*session* settings do not earn their place, and adding them
means changing `docs/product.md` first.

`WorktreeRoot.siblingDirectory` is a `.worktrees/<slug>` directory beside the
repository. It keeps `~/` tidy and keeps relative paths short, which matters
because build tools embed them.

### Automation

`AutomationScripts` is a partial record from event to `AutomationScript`, and it
lives in **Janela's database, never in the repository**: a committed file that
runs commands makes cloning a repo a code-execution vector. `script` is a shell
script, verbatim — the **one deliberate exception** to the argv rule every other
process Janela spawns follows. A lifecycle hook is the user's own shell logic
(pipes, `&&`, variables, a heredoc), and an argv array made them spell
`["zsh", "-lc", "…"]` to get any of it; the daemon hands the string to their login
shell with `-c` and adds nothing to it, so no quoting is ever Janela's. There is
no `isEnabled`: an absent, blank or comment-only script runs nothing, which
`scriptRunsAnything` decides and `automationScriptOf` applies, so the runner, the
removal plan and the Settings violation all agree on what "nothing" is. A user who
wants a hook off comments it out. `timeoutSeconds` bounds how long deletion waits
for a `sessionTeardown` script and is ignored for the other events, which block
nothing.

`AUTOMATION_VARIABLES` is the documented `JANELA_*` namespace a script may read,
as data: Settings renders it beside the editor, and `@janela/session` builds the
real environment from the same names. `JANELA_PROJECT_DIRECTORY` exists because
the first script anyone writes copies a file from the project into the worktree,
and `JANELA_SESSION_DIRECTORY` alone could not say where *from*.

Three events, and a fourth means changing `docs/product.md` § Non-goals first.
This is not a task runner: no scheduling, no retry, no dependency graph, no
conditional execution.

- `worktreeCreated` — the managed worktree exists *and* `.worktreeinclude` has
  finished copying. The ordering is load-bearing: scripts depend on their `.env`
  already being present.
- `sessionStart` — once per session, not once per app launch. Restarting Janela
  does not re-run `pnpm dev`.
- `sessionTeardown` — the only blocking event, bounded by `timeoutSeconds`.

## session-layout.ts

Per-session *state*, persisted with the session — not a saved object the user
names and manages. "The layout is wherever you left it" only works if where you
left it is written down.

`tabs` is never empty in a session that has terminals; a session with no
terminals has no tabs. `focusedTabIndex` and `LayoutTab.focusedTerminalID` are
clamped and repaired on decode rather than trusted. An absent tab `title` means
"derive from the focused terminal", which is what users expect until they rename
a tab explicitly.

`Pane` is binary rather than n-ary because every split operation the UI offers is
binary, and because promoting a sibling when a pane closes is trivial in a binary
tree and fiddly in an n-ary one. On `Axis`: `horizontal` puts panes side by side
and the divider is vertical; `vertical` stacks them.

`MAXIMUM_PANE_DEPTH` is not a style preference. `Pane` is recursive and decoded
from a persisted blob, so an unbounded depth is a decoding hazard; and past about
four levels a pane is too small to read anyway. `FRACTION_RANGE` exists because a
pane you cannot see is a pane you cannot close, and a non-finite fraction becomes
a half.

### Bounded on hostile input

`exceedsDepth` is iterative and never pushes the children of a node already at
the bound, so it visits at most `2 ** MAXIMUM_PANE_DEPTH` nodes however deep the
input is. It runs on the untrusted blob, before anything recurses.
`truncateDepth` then collapses whatever sits below the bound to its left-most
terminal, which is why every other repair step may be recursive: they all run on
its result. Terminals lost from the tree still exist in `session.terminals`,
because decoding truncates rather than fails. `firstTerminalID` is iterative for
the same reason — it runs during repair.

`paneDepth` *is* recursive, so it is for trees already known to be bounded: one
this module just built, or one that has been through `repairLayout`.

`replaceTerminal`, `removeTerminal` and `resizeParent` rebuild only the path to
the pane they touch and reuse every untouched subtree by reference.

### The operations

- `splitPane` — the existing terminal keeps its place (left, or top) and the new
  one takes the other half of an even split, then takes focus within its own tab;
  splitting a pane is not switching tab. Returns the layout unchanged when the
  named terminal is absent, when the new id is already in the tree or is the
  named one (a terminal appears in a layout exactly once), or when the split
  would exceed `MAXIMUM_PANE_DEPTH`.
- `closeTerminal` — closing the last terminal in a tab closes the tab, and
  closing the last tab returns an empty layout, which is a state a session is
  allowed to be in: a session is a directory, and its terminals are what happens
  to be open in it. Focus moves to the first terminal of the promoted sibling only
  when the closed terminal held it.
- `focusNeighbour` — walks tab-then-tree order, the order `layoutTerminalIDs`
  returns, wrapping at both ends. `focusedTabIndex` follows across a tab
  boundary; the tabs left behind keep their own focus.
- `moveTab` — returns the layout unchanged **and by reference** when the move
  would change nothing (`from === to`, or an index outside `0..tabs.length - 1`).
  Identity is part of the contract rather than an optimisation: it is how the
  daemon decides a drag that ended where it started needs no write.
  `focusedTabIndex` keeps naming the tab it named before the move, so dragging
  some *other* tab never switches the user's view.
- `moveTerminal` — a pane leaves its place (`closeTerminal` does the removal, so
  an emptied tab vanishes and the tab left behind refocuses) and docks: beside a
  named pane at one of four edges, at the right of a whole tab, or in a new tab
  appended last. Focus follows the moved pane. Unchanged **and by reference** — the
  same contract as `moveTab` — when the terminal or target is absent, the target is
  itself, a lone pane is detached or dropped on its own tab, a tab index is off the
  end, or the dock would exceed `MAXIMUM_PANE_DEPTH`.
- `repairLayout` — called on every load. A corrupt layout must degrade, never
  throw: the alternative is a session the user cannot open. `seen` is shared
  across every tab, so "exactly once" holds layout-wide and the first occurrence
  in tab-then-tree order survives. Truncation runs first, so no later step
  recurses past the depth bound. Focus stays on the tab the user was looking at
  rather than blindly clamping the number they had.
- `layoutViolations` — what `@janela/db` logs on load, so it reports shapes (a
  tab index, a terminal id, a count) and never content. A depth breach is
  reported before anything inside the over-deep subtree, because that subtree is
  exactly what is not walked.

## session.ts

A session is *a directory with terminals in it*. That is the whole idea;
everything else — projects, worktrees, agents, pull requests — hangs off that
sentence rather than competing with it.

Deliberately not modelled: an `isWorktree` flag (worktree-ness is provenance,
recorded in `backing`), per-session settings trees (settings are global or
per-project; sessions carry state), and derived status. "Is this session
running?" is a question about its terminals, answered on demand, never stored.

`projectID` is optional and that is load-bearing: "just give me a terminal in
this folder" is a first-class case, not a degenerate one. A standalone session
has no automation, no worktree option and no forge state because it has no
project to get them from — nothing else differs. `name` is never required to be
unique; identity is the `SessionID`.

`Backing` is the *only* place worktree-ness enters the model. A worktree-backed
session is a normal session with extra provenance — not a separate type, not a
separate list, not a separate screen. That asymmetry is the whole product thesis;
see `docs/product.md`.

- `folder` — a directory the user picked, with no project. No git involvement is
  assumed, though the directory may well be a repo; we detect that
  opportunistically and never act on it uninvited.
- `projectDirectory` — the project's own checkout. We must never offer to delete
  the directory.
- `worktree` — `binding.ownership` decides whether we may remove it.

`WorktreeBinding` is a small value rather than a first-class entity on purpose: a
worktree has no independent life cycle in Janela. It is created with a session
and dies with it, and giving it an identity would be the first step back toward a
worktree-centric model. An absent `branch` is a detached HEAD, and `baseCommit`
is what tells the user how far behind they are. `includedPaths` records what
`.worktreeinclude` copied in at creation time rather than recomputing it at
deletion time, which is what lets the removal dialog say "and a 400 MB
`node_modules`, and an `.env` that exists nowhere else" instead of "are you
sure?".

`ownership` is the same question as who may delete: `managed` means Janela
created the worktree and may offer to remove it; `adopted` means it already
existed when we found it, and we will never delete one of those without an
explicit, unambiguous user action.

### The invariants `backing` enforces

Checked on decode rather than trusted. `backingViolations` returns the reasons a
session is invalid, empty when it is fine, and is used by `@janela/db` on load
and by the protocol layer on decode: a session that violates one of these
arrived from somewhere that should not have produced it.

| Backing            | `projectID`     | May delete the directory            |
| ------------------ | --------------- | ----------------------------------- |
| `folder`           | must be absent  | never                               |
| `projectDirectory` | must be present | never — it is the user's checkout   |
| `worktree`         | must be present | only when `ownership === "managed"` |

Deliberately **not** checked there: `binding.path` against `directory`. A
mismatch means the user moved the worktree, which is something to re-resolve
rather than a reason to refuse to load the session.

## terminal.ts

`TerminalDescriptor` is the *persistable* description of a terminal, not the live
one — that is `LiveTerminal` in `@janela/terminal`, which holds a file
descriptor, a child process and an emulator. Keeping the two apart is what lets
`@janela/core` stay free of I/O, and it is what makes "restore my layout" mean
"restore descriptors" rather than "restart everyone's shells".

`title` starts as `Shell`, then follows the terminal's OSC 0/2 title sequences
once the process starts talking. Every terminal runs the user's login shell; an
absent `workingDirectoryOverride` means the session directory, and it is set when
the user splits a terminal while `cd`'d somewhere else. `startsAutomatically` is
typically true for the first terminal only — the rest are lazy, which is how
forty configured terminals cost nothing.

`TerminalRole.automation` terminals are ordinary terminals with a label. They are
not a hidden process with a bespoke output view: everything Janela runs on the
user's behalf runs somewhere the user can watch it, scroll it, and Ctrl-C it.

`TerminalState` is coarse, and there is still no `waitingForUser` and no
`agentThinking`: Janela does not parse agent semantics out of a byte stream. It
reports what the *terminal* told it — OSC 9 / OSC 777 notifications, OSC 133
prompt marks, BEL — and, since a harness can be made to say so, `OSC 7770`.
`exited` carries the status so the UI can distinguish 0 from 130, and a `failed`
message is safe to show a user.

`AgentActivity`, `AgentNeed` and `AgentOutcome` live here rather than beside the
codec in `agent-activity.ts` because they are *state*, and `TerminalState` is
what crosses the socket. `running` carries `activity` beside `progress` and
`needsAttention` carries it alone; both are optional, both are exactly what was
said, and a terminal that has never had a harness in it encodes as it always
did. Which of them is set is the daemon's decision and is described in
[`terminal.md`](terminal.md) § What an activity report does to the state: a
`waiting` or `finished` report raises attention, `working` clears it, and only
`start()` clears the activity itself.

A *session's* status is derived from its terminals rather than stored: two
sources of truth for the thing the sidebar is judged on would be one too many.
`TerminalState` crosses the socket, so the daemon computes it and pushes it, and
clients render what they were told rather than inferring it from what they
themselves did.

`GridSize` is cells, not pixels. Pixel metrics are a client fact and do not
survive multiple clients on different displays.

## Tests

`identifier()` and `absolutePath()` are their own seams, and the values in
`session.test.ts` and `session-layout.test.ts` never leave the test, so they are
branded directly — a layout function must not care what an id looks like.
`require-safety-comment-for-type-assertion` is off for test files for that
reason.

`session-layout.test.ts` builds its 5000-deep fixture, and the id list for it,
with a loop: the hostile depth `repairLayout` exists for cannot be constructed,
or enumerated, by recursing.
