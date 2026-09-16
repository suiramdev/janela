# @janela/session

Layer 5, daemon side. The brain: project and session lifecycle, project
automation, the captured login-shell environment, launch profiles and removal
planning. It composes git, the terminal layer, the database and the forge into
the operations a client can ask for.

What this package deliberately does not know: that a socket exists, that one of
its peers is a WebView, or what a client is. It announces change through
`StateObserving`, an interface it owns, so it stays usable — and testable — with
no networking at all. Nothing here may import a view layer: the daemon detects
attention, the client decides what it means, the app delivers it
([`../architecture.md`](../architecture.md) § The layering rule).

Budgets for creation and for interaction live in
[`../performance.md`](../performance.md) §§ Session creation, Interaction, Launch.
What is faked here and why is [`../testing.md`](../testing.md) § "We **do** fake
slow or non-deterministic collaborators"; the end-to-end proof that a session's
terminals outlive the app is [`../survival-proof.md`](../survival-proof.md).

Effect is used at three seams only: a subprocess or filesystem call that may
fail, the `.worktreeinclude`/automation steps whose failure is non-fatal, and the
worktree-creation rollback. Everything public stays Promise-based; the Effect
programs are run with `Effect.runPromise` inside the method that owns them.

## errors.ts

Twelve `UserFacingError` subclasses and nothing else. They keep that base
because the `instanceof` contract crosses the daemon/client decision:
`@janela/daemon` imports `UnknownTerminal` by name and turns anything
`isUserFacing` into a `UserFacingFailure` on the wire. None of them carries a
`_tag` — there is no `Match`, `catchTag` or `Predicate.isTagged` consumer
anywhere, and a tag nobody branches on is noise.

Every class carries a `summary` a person can act on, because an error is either
shown or logged and never both raw. The `message` is for the log and may name an
id; a `summary` never does, and no message here carries a filesystem path — a
path in a headline is how a dialog turns into a bug report.

| Class | What no longer resolving means |
| --- | --- |
| `UnknownProject` | Two windows, one removed the project while the other still showed it. |
| `UnknownSession` | The same race, one level down. |
| `UnknownTerminal` | A stale mirror, or a split named beside a terminal of another session. |
| `UnknownLaunchProfile` | Two settings windows, one deletion. |

The refusals are the interesting half:

- `WorktreesUnsupported` — a worktree session, or a branch to check out, was
  asked for in a project that is not a repository. "No branches" and "not a
  repository" are different things to tell a person, and an empty list says the
  wrong one.
- `ProjectAlreadyAdded` — the client chose the directory and can name it, so the
  path stays out of `message`.
- `LayoutTooDeep` — refusing is honest; silently opening a tab instead answers a
  question the user did not ask. The bound is `MAXIMUM_PANE_DEPTH` in
  `@janela/core`.
- `BuiltInProfileProtected` — a deleted built-in would come back on the next
  daemon start, because the seed is idempotent, and look like a bug. Editing is
  offered; copy-and-edit is the answer for wanting a different one.
- `LaunchProfileUnavailable` — the profile is normally *hidden* rather than shown
  broken, so this is the case where the user started it anyway: configured before
  the tool was uninstalled, or a session restored on another machine.
- `NotAWorktree` — `adoptWorktree` for a directory git does not list as a
  worktree of that project.
- `PullRequestsNotSupported` — its own error rather than a silent no-op, thrown
  at the top of the `fromPullRequest` resolution, so the one branch that has to
  change when the forge integration lands is impossible to miss. An absent
  `ForgeServing` is this daemon having been composed without one, which from the
  user's side is the same thing.
- `DirectoryUnreadable` — the folder a browser client asked to see could not be
  read. The `reason` is chosen from the errno (`ENOENT`, `ENOTDIR`, `EACCES` /
  `EPERM`) and nothing else, so what the user reads is one of three sentences
  and the message carries the code, never the path.

## directory-browser.ts

`DirectoryBrowsing` answers protocol v8's `listDirectory` for a client that has
no folder picker of its own — a browser page — with one folder of the daemon's
filesystem. The Mac client never calls it; it has the real one.

- **One folder per request, never a tree.** The client walks; the daemon reads
  what it is asked for. Nothing is prefetched (§ Non-negotiables 5).
- **Bounded** at `DIRECTORY_ENTRY_LIMIT` (1,000) entries *after* sorting, so the
  cut is deterministic and the first thousand alphabetically are what a user sees
  with `truncated: true`. A `node_modules` is read once, by name only, and never
  serialised whole (§ Non-negotiables 9).
- **Dotfiles are left out**, as Finder leaves them out, which also keeps `.git`,
  `.ssh` and `.env` names off the wire.
- **Symlinks take their target's kind**, resolved with one `stat` each — only for
  the symlinks that survived the cut, so the cost is bounded by the limit too — and
  a dangling one is dropped rather than shown as a folder that will not open.
- **The path is resolved** (`..`, trailing slashes) before it is read *and* before
  it is reported, so what a client shows in its path field is what it will send
  back as a working directory. `undefined` means the home the daemon was given;
  the listing carries `home` so the client can offer it without asking twice.
- **The sort is `Intl.Collator` with `numeric`**, which is what Finder does:
  `item2` before `item10`, and case does not split the list in two.

It lives here rather than in `@janela/daemon` because it is a service the daemon
composes — with a `home` injected, so a test walks a temporary tree — and its
failure is one of this package's `UserFacingError`s.

## session-service.ts

One `Session` type and one creation entry point. Worktree creation is a *case of*
`createSession`, not a feature with its own screen; a second public creation
method means something has gone wrong. A session may also stand alone with no
project at all — a first-class case, not a leftover bucket, which is why
`standaloneSessions` is part of the interface rather than a filter a client
applies.

`SessionCreationRequest` and `SessionRemovalPlan` are mirrored by
`@janela/protocol` (`SessionCreationIntent`, `SessionRemovalPreview`) rather than
shared. The wire shape is frozen by the protocol version; this one is free to
grow a field. `ProjectBranchOverview` mirrors `BranchOverview` the same way, and
carries two lists rather than a map because a worktree may be detached and name
no branch while a branch may be checked out nowhere.

### The creation order, and why it is that order

`persist → publish → worktree → .worktreeinclude → worktreeCreated → sessionStart
→ first terminal`, asserted as one sequence in `session-service.test.ts`.

The session is persisted and announced before any of the slow steps, so it is
visible and selectable while `pnpm install` is still running. The copy precedes
automation because a `worktreeCreated` command that runs first finds no `.env`.
The terminal is last and is *configured, not started*.

Nothing blocks on a client. The requesting client may disconnect mid-flight
without changing the outcome.

### Laziness

`load()` reads the database and nothing else: a restored session's terminals are
idle by construction, because the registry is empty until `startTerminal`.
`createTerminal` spawns nothing. Attaching starts nothing. That is what makes
opening a session free.

### Where the directory comes from

A worktree is one way a session's directory comes to exist, not the point of the
app. `worktreeSlug` preserves case — branch names are case-sensitive and the user
reads this path in a shell prompt and in build output — and replaces only the
characters that make a path awkward. A name of nothing but separators (`///`)
would collapse to the empty string and put the worktree at the *parent*
directory, so it falls back to `worktree`.

`defaultWorktreeDirectory` names the directory after the **session name**, not
the branch. That is what lets a second worktree of one branch exist: the user
renames the session and the path follows, instead of us appending a `-2` nobody
asked for. Protocol v7 froze that meaning of `name` — see
[`protocol.md`](protocol.md) § Version history. The default placement is
`../.worktrees/<slug>`, beside the repository rather than under it: a worktree
inside the repository is a directory git has to be told to ignore, forever.

`shareBranch` is the only thing that passes `--force` to `git worktree add`. git
refuses one branch in two worktrees by default and we do not override that on the
user's behalf; it is set only when the user chose a new worktree for a branch
already checked out, having been told the branch will be shared.

`inProject` with a `branch` moves the project's **own** checkout, so it runs
before the record exists and before anything is announced: a checkout git refuses
must leave no session behind.

`fromPullRequest` resolves the head branch through the forge and then feeds the
ordinary worktree path — never `gh pr checkout`, which would move the user's own
checkout onto the pull request's branch. The start point is `origin/<branch>`
because `worktree add -b <branch> <dir>` with no start point silently branches
off HEAD when the pull request's branch was never fetched; the remote-tracking
ref fails honestly instead, with git's own reason.

`adoptWorktree` takes **git's canonical path**, not the one the dialog produced.
On macOS those differ (`/var` against `/private/var`), and the session compares
its directory against git's output forever after, so keeping the wrong one leaves
a session equal to neither. `canonicalPath` is `realpath` with the path itself as
the answer when it does not resolve — an absence, not a failure.

### The rollback

`addWorktree` is `Effect.acquireRelease` over the session id, with
`Exit.isSuccess` in the release arm. Persist-first means a crash between the
record and the directory leaves a session pointing at nothing; a failure we *see*
un-persists the record, so the user is not left with a session they cannot open
and did not ask for. The `GitFailure` is re-raised with its identity intact —
it already says which git subcommand refused and why, which is more useful than
anything we could add.

`.worktreeinclude` and automation are the opposite: a failure is logged as a
shape and creation continues. An `.env` that did not arrive costs the user a copy
they can make themselves; refusing the session over it costs them the terminal.

### Removal

`removalPlan` reports specifics rather than a bool, so the confirmation can name
what is about to be lost — "Are you sure?" is not a warning.

`canDeleteDirectory` is the **safety** field and `deletesDirectory` is the
**consequence**: the first says whether Janela created the directory, the second
is set by the client when the user ticks the box. It defaults to `false`, and
`removeSession` re-checks `canDeleteDirectory` rather than trusting the tick, so
an adopted worktree or a project checkout is never ours to delete whatever a
stale plan from another window says. [`../testing.md`](../testing.md) § Domain
rules calls that a safety rule stated as a test.

`includedPaths` is recorded at creation rather than recomputed at deletion, so
the dialog can name the 400 MB `node_modules` it is about to take with it.
`hasRunningSessions` is ours and only ours: git cannot know what is live, so
`WorktreeServing` always reports `false` and this layer overwrites it. `--force`
is passed exactly when the user was shown and accepted uncommitted or untracked
work; without it git refuses and the tick did nothing.

`sessionTeardown` runs first and blocking, and runs to completion even if the
requesting client disconnects — a teardown abandoned halfway because a window
closed would leave exactly the containers and databases it exists to clean up. A
non-zero exit is logged and removal continues: refusing to remove a session
because a cleanup script failed traps the user.

### Terminals

`publish` sends the whole list every time. `StateUpdate` merges by id and cannot
express a deletion, so a delta would leave removed sessions in every mirror.

`createTerminal` with no placement is a new focused tab (⌘T); with a `split`
placement the pane holding `beside` divides (⌘D). Membership is checked first, so
the only refusal `splitPane` has left to express by returning the same layout is
depth. Focus is a parameter of `appendTerminalTab` because the two callers
disagree for a reason: the user asked for their own terminal, and an automation
command starting while they read the last one's output must not steal the tab.

`restartTerminal` exists because the daemon owns the ordering: `stop()` closes the
pty but the terminal stays `running` until its reader thread reaps the child, so a
`startTerminal` that followed a `stopTerminal` over the wire would find a terminal
it believes is already running and do nothing at all.

`stopTerminal` on an unknown id is a no-op — a second click on "stop" must not be
an error, and a terminal that already exited is not registered. `removeTerminal`
never leaves a session with zero terminals: the last close leaves one fresh idle
shell honouring the project's default profile.

`moveTab` lives here because tab order is part of `SessionLayout`, which the
daemon owns; a client that rearranged its mirror would lose the drag on the next
snapshot. A move that changes nothing — including an index off the end — writes
nothing and announces nothing, which `moveTab` in `@janela/core` signals by
returning the same layout by identity.

`moveTerminal` is the same shape: both terminals named must belong to the
session (`UnknownTerminal` otherwise), the layout operation in `@janela/core`
decides, and identity means nothing is written or announced — including a dock
the depth bound refused, which the strip and the pane swallow as they swallow a
failed split.

`projectRemoving` stops the project's terminals and forgets its sessions without
a `repository.remove` per session: the rows cascade with the project, and
deleting them twice would be two round trips to say the same thing.

## project-service.ts

Separate from `SessionService` because the two answer different questions: this
one owns "what has the user added and how is it configured", the other owns "what
is the user working on". `ProjectRemovalObserving` is a one-method interface so
the two compose without a cycle, and so this package's tests can remove a project
with no session service at all.

The **client** chooses the directory through a native file dialog. The daemon
never discovers directories on its own and never scans the home directory — that
is what keeps macOS permission prompts attributed to the app the user clicked
rather than to a background binary they have never heard of.

`addProject` announces before git runs. Detection is opportunistic and never
blocks: a plain folder is a perfectly good project that simply cannot offer
worktree-backed sessions. `refreshGit` announces again at the end even when
nothing changed, so a client knows detection has settled rather than waiting
forever for a second update, and it re-checks that the project still exists
first — announcing one that is gone would resurrect it in every mirror.

`detectGit` uses `probe` throughout: not being a repository is an answer, not a
failure. A directory whose `rev-parse --show-toplevel` names a *different*
directory is a folder project, not that repository — `worktree add` from a
subdirectory would run against a repository the user did not choose. The
comparison is `realpath` on both sides because macOS reports `/var/…` and
`/private/var/…` for the same directory while git canonicalises and a file dialog
does not.

`defaultBranch` is always set for a repository, and that is load-bearing: a
`GitDescriptor` whose three fields are all absent reads back from the database as
no descriptor at all, so the project would look like a plain folder and its
worktree sessions would silently disappear after a restart. `detectDefaultBranch`
prefers `origin/HEAD`, then `HEAD`, then `main`/`master`, then the literal
`HEAD` — which is what git itself shows for a repository with no commits, and a
start point `worktree add` accepts.

`forgeForRemote` recognises a host and nothing more. Whether the integration
*works* additionally depends on `gh`/`glab` being installed and logged in, and a
missing one is silence rather than an error banner. Self-hosted GitLab is
overwhelmingly `gitlab.<company>` or `gitlab-ee.<…>`; the URL is all we have and
we do not probe an unknown host to find out. `git@github.com:user/repo.git` is
not a URL and `new URL` refuses it, which is exactly the form `git clone` hands
out by default — hence the scp-like pattern before the URL parse.

Removing a project deletes its sessions and never a directory. A per-session
removal plan is the only path that deletes files, and it asks first.

## automation-runner.ts

**Automation is visible.** Each command runs in a real terminal the user can
watch, scroll back through and Ctrl-C, with `role: automation(event)`, in the
session's directory, with the session's environment. That is a product rule, and
it is why this type creates terminals rather than capturing output. A failing
command is shown in its own terminal, never in a dialog.

What it is not: a task runner. No scheduling, no retry, no dependency graph, no
conditional execution. Three events, a command each, in order — sequential by
contract, because "in order" is the only scheduling this has.

Commands come from `project.settings.automation` and from nowhere else. There is
no filesystem import in this file, deliberately: a checkout that can add commands
makes cloning a repository a code-execution vector. There is a test that writes a
`janela.toml`, a `.janela/commands.json` and a hostile `Makefile` next to the
session and proves none of them is read.

`attach` is a sink rather than a return value, because a teardown terminal
published only once teardown finished is a terminal the user could never watch.
It is called *before* the process starts. A failure there is the
disconnected-client path: it is logged and the command still runs.

`sessionStart` fires once per session, and the record that it fired is the
persisted automation-role descriptor itself. A terminal with
`role: automation(sessionStart)` in `session.terminals` is what "it ran" looks
like from the database, and it survives a daemon restart for free — restarting
Janela does not re-run `pnpm dev`. It is checked once per `run`, not per command,
because the sink appends this run's own descriptors as it goes.

`worktreeCreated` and `sessionStart` return once the terminals have been
*created*; nothing waits for `pnpm dev` to exit. `sessionTeardown` is the one
blocking event, bounded by each command's own `timeoutSeconds` through
`Effect.timeoutOption`. A command that overruns is **not** stopped here:
`removeSession`'s stop-all loop is next, and killing it twice would only make the
report lie about which of us did. A zero or negative `timeoutSeconds` still gets
one look at the state, so a command that exited instantly is reported as exited
rather than as timed out.

The wait polls `LiveTerminal.state` rather than subscribing, because
`LiveTerminal.events` is a single sink the daemon owns for attention fan-out and
claiming it here would silently cost the user their notifications. The daemon's
frame loop is what advances `state` in production. `DEFAULT_AUTOMATION_POLL_MS`
is 50 ms, far below the time any teardown script takes.

The `automation` log category records which event fired, which command and its
exit status — never the command's argv beyond the descriptor title the user can
already see, and never its output. See
[`support.md`](support.md) § log.ts.

## shell-environment.ts

A GUI app launched from Finder inherits launchd's environment, not the user's.
`PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`, and every tool installed with
Homebrew, mise, nvm or asdf is missing. This is the single most common way a GUI
terminal app feels broken, and the reason "claude: command not found" gets
reported as a bug in the IDE. A separate daemon does not fix it: `janelad` is
started by launchd too.

The fix for a *terminal* is to exec the user's login shell with `argv[0]`
prefixed by `-` and let their own dotfiles build the environment. The leading `-`
is not cosmetic — `zsh` checks `argv[0][0] === '-'` to decide whether to source
`.zprofile`. We never reimplement their shell configuration and never parse their
`.zshrc`.

The fix for *us* — checking whether `claude` exists before offering the profile —
is to run one login shell at daemon startup and cache the result. Resolved once,
after a client connects, never on the launch path
([`../performance.md`](../performance.md) § Launch: nothing blocks first paint).

### Which shell

`getpwuid` first, because it is the answer macOS itself uses. `$SHELL` is only a
hint: it is whatever the *parent* was started with, which for a launchd daemon is
nothing, and it is used only when it is absolute.

Bun does not call `getpwuid` and answers `"unknown"` for both the shell and the
username, and `bun:ffi` is gated to `@janela/pty` so we cannot call it ourselves.
That sentinel is worse than no answer: Directory Services answers
`/Users/unknown` with `UserShell: /usr/bin/false` and exit 0, which looks exactly
like a real shell and silently costs the user their whole environment. `usable()`
rejects it for both fields, and `$USER`/`$LOGNAME` — which launchd does set —
stand in for the name. The `getpwuid` branch stays so the free path wins if Bun
grows it.

`dscl` is behind `which` rather than a platform check: it is the supported way to
ask Directory Services for the record `getpwuid` reads, and it is absent
everywhere but macOS.

### The capture

`printf '\0JANELA_ENVIRONMENT\0'; /usr/bin/env -0`, run with `-i -l -c`.
Interactive as well as login because that is where users put `PATH` edits, and a
`PATH` we did not capture is a launch profile we hide for no reason. The flags
are separate rather than `-ilc`: fish's option parser rejects the bundled form.

The marker exists so a dotfile that greets the user (`fortune`, a version
manager's banner) cannot be mistaken for a variable, and the **last** marker is
taken so a dotfile that prints the script itself (`set -x`) does not have us
parse the trace. `env -0` and a NUL-delimited marker because a value may contain
a newline, and a line-based parse would turn one variable into two, one of them
nonsense.

Only POSIX-shaped names survive: a shell function exported by bash
(`BASH_FUNC_x%%`) is not a variable. `_`, `SHLVL`, `PWD` and `OLDPWD` are
dropped — they are facts about the capture process rather than about the user.
Invalid entries are dropped individually rather than refusing the whole dump,
because one exported bash function must not cost the user their `PATH`; only a
missing marker or an empty result is a failed capture.

It always resolves. An unusable shell configuration must not stop the daemon from
serving, so every failure path returns the daemon's own environment plus a
warning.

### No environment value is ever logged

AGENTS.md non-negotiable 11, and
[`../conventions.md`](../conventions.md) § Logging: the daemon writes to the same
system log the app does, and an environment value is the user's private data.

The rule is carried by the type. `abandonCapture` is the only place in this file
that logs a failure, and its second parameter is `CaptureFailure` — `shell`,
`exitCode`, `timedOut` and a `CaptureFailureReason` literal, and nothing else. A
value cannot be added without changing that type. The success path logs a count.
`shell-environment.test.ts` drives all five paths with a secret in both the
inherited environment and the captured output, and asserts that no record's
serialisation contains either and that every field key is one of five allowed
shapes.

### janelaVariables

`JanelaVariables` is an explicit interface rather than an open record, so the
list stays short and every addition is a decision: terminal programs are
unusually sensitive to this namespace and each variable here is one the user
cannot control.

`JANELA_PROJECT`, `JANELA_BRANCH` and `JANELA_AUTOMATION_EVENT` are **absent**
rather than empty when they do not apply. A script tests `set -u`-safely for the
variable, and an empty `JANELA_BRANCH` on a detached worktree would read as a
branch whose name is the empty string.

## terminal-launch.ts

`@janela/terminal` receives an answer rather than computing one, because this is
the only layer that knows about projects, profiles and the user's shell.

`TERM` and the `JANELA_*` namespace are applied **last**, after the captured
environment and after the profile's own: they are facts about the terminal we
created, and a profile that overrode them would be describing a terminal that
does not exist. `DECLARED_TERM` is `xterm-256color` rather than a bespoke
terminfo entry, so every existing tool works on day one; revisit only if we ship
a terminfo file, and note that the client renderer and the daemon emulator are two
different libraries that must agree on what they claim to be.

An empty argv is the login shell, dash-prefixed — the case that makes the app feel
like Terminal.app. Otherwise the executable is resolved against the captured
`PATH` here rather than left to `execve`, so the user gets "Claude Code isn't
installed." instead of an errno, and the name in that sentence is the profile's,
not the binary's. A command containing `/` is taken as written. `argv` reaches the
child verbatim, so `argv[0]` is what the user wrote and a program printing its own
usage line reports the right name.

`DEFAULT_INITIAL_SIZE` is 80×24 because something has to be chosen:
`negotiatedSize([])` has no answer and the child may print before the first
viewport arrives. The first `attach` resizes.

## launch-profile-service.ts

Answers "what can be started", where `SessionService` answers "what is the user
working on". A profile is *not* an integration: we resolve its executable and
start it, we do not model the tool.

`availability` is keyed by id and kept separate from the profile itself. It is a
fact about this machine now, not something the user authored, and installing the
tool must not require editing the profile. A profile whose executable is not on
the captured `PATH` is **hidden rather than shown broken** — hiding is the
client's decision and this record is the fact it needs.

The `PATH` handed to `which` is the profile's own, then the captured
login-shell one, then `/usr/bin:/bin` as a last resort — never the daemon's; see
[`support.md`](support.md) § process.ts for what `which` does with it and why it
ignores `process.env.PATH`. An empty argv is the login shell, which exists by
construction and is never probed. A `which` that cannot run tells us nothing
about the tool, so the profile is reported available: reporting otherwise would
hide one that works.

Probing is sequential on purpose. `which` is a subprocess, and a user with thirty
profiles should not open thirty shells at once during daemon startup.

`isBuiltIn` is ours, never the caller's. Editing a built-in keeps it built-in —
that is what the settings surface offers — and nothing sent from outside can mint
one, because a caller able to set it could make its own profile undeletable or a
shipped one removable. `save` copies the caller's arrays and records rather than
aliasing them: a client's object graph has no business being the daemon's state.
`remove` rebuilds the availability record rather than `delete`-ing a key, so a
mirror that merged it cannot keep a stale `true`.

## state-observing.ts

Two methods, and the reason the layering holds. `@janela/daemon` implements this
and fans out to subscribers; a test implements it with an array. Neither is
visible from here, so this package cannot accidentally grow a dependency on the
wire format.

## silent-logger.ts

The default when a caller injects no logger. Discarding is right for the same
reason `nullLogSink` is: a library must not decide the log format for a process
that has not asked for one. Internal on purpose — the composition roots inject
the real one.

## test-fakes.ts

Not exported from `index.ts`, and that is deliberate: these are this package's
tests' business, and a fake on a public API is a fake somebody ships.

What is faked here is the *sequencing* around the real collaborators, never the
collaborators [`../testing.md`](../testing.md) refuses to fake. Git is not faked
anywhere in this package as a source of truth: `session-branches.test.ts` drives
a real repository through `worktreeService`, and `@janela/git` owns whether
`worktree add` works. `fakeWorktrees` replaces the *order* things happen in, and
its `canonicalise` hook exists because production really does return a different
string for the path it was asked with.

`eventLog` is one clock every collaborator writes to. Ordering is the contract
`createSession` exists to keep — the copy before the automation, the automation
before the terminal — and a shared log is the only way to assert it.
`recordingObserver` snapshots each announcement with `structuredClone`, because
the service holds one array and mutates it, so a reference would make every past
announcement equal to the present; its `publish[t=N]` entry is how many terminals
the announcement carried, which is what proves the terminal came last.

`scriptedGit.hold()` blocks every invocation until released. That is what lets a
test assert `addProject` announced *before* git ran, with no timer: the probes
cannot finish, so anything observed must have happened first. `failingGit` throws
on any use, for proving a path runs no git at all.

`fakeCreateTerminal` spawns nothing. PTYs are not faked in this repository as a
rule, but the thing under test here is which launch the brain resolved and when it
registered it; a real PTY would only add a child process to a test about
bookkeeping. `FakeLiveTerminal.setState` exists because the daemon's frame loop is
what advances `state` in production and a fake has to be told.

`recordingLogger` is how "we log shapes, not content" is asserted.
`@janela/test-support`'s recording sink is global and unimplemented, and every
logger in this package is injected, so a local fake is enough.
