# Domain model

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> **The model itself is current and correct** — four nouns, the backing invariants,
> the vocabulary, the deliberately-absent table. What is stale is the *syntax*: the
> types are shown in Swift and live in `JanelaCore`. They are now TypeScript in
> `@janela/core`, with three changes worth knowing: timestamps are ISO strings
> rather than `Date`, paths are branded strings rather than `URL`, and
> `symbolName` is `iconName`. Every rename has a row in
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md).
>
> Current: [`AGENTS.md`](../AGENTS.md) for commands and layering,
> [`architecture.md`](architecture.md) for the system,
> [`MIGRATION_MAP.md`](MIGRATION_MAP.md) for where every module, type and seam went.
> Rewriting this file is a tracked follow-up.


The nouns, what they mean, and — as importantly — what they deliberately do not
mean. This is the shared vocabulary; use these words in code, in UI copy, and in
issues.

All types live in `JanelaCore` and are `Sendable` value types with no I/O. Since
the daemon owns the sessions, that carries a second meaning: `JanelaCore` is the
vocabulary **both processes share**, so these types cross a socket and must stay
cheap to encode and free of anything process-specific.

---

## The whole model

```text
Project ──────────► Session ──────────► Terminal ──────► LaunchProfile
(a directory we    (a directory with   (one PTY +       (a thing to run)
 know about, its    terminals in it)    emulator)
 settings and
 automation)              │
      ▲                   │
      └── optional ───────┘        a session with no project is standalone
```

Four nouns. That is the entire concept budget, and
[`product.md`](product.md) § 1 explains why adding a fifth is expensive.

The tree is exactly two levels deep and the second level is flat. Everything else
— worktrees, splits, tabs, pull requests, automation — hangs off one of these four
as a value, never as a fifth entity.

---

## Project

> **A directory you added, so Janela can offer to do things in it.**

`Project` holds a `name`, a `directory`, an optional `git` descriptor, its
`settings` (automation, worktree placement, forge), and presentation state
(`accent`, `isExpanded`, `sortIndex`).

```swift
public struct Project: Identifiable, Hashable, Sendable, Codable {
    public let id: ProjectID
    public var name: String
    public var directory: URL          // the main checkout, or just a folder
    public var git: GitDescriptor?     // nil when the directory is not a repo
    public var settings: ProjectSettings
    public var accent: Accent
    public var isExpanded: Bool
    public var addedAt: Date
}
```

**A project is a container *and* an index.** It contains sessions — deleting a
project deletes them, which is why deletion asks the removal question once per
session. It indexes a repository so that "new branch" is one step instead of a file
picker.

**`git` is a cache, not a truth.** `GitDescriptor` carries `remoteURL`,
`defaultBranch`, and the detected `forge` (GitHub, GitLab, or none) so a sheet can
preselect sensibly without shelling out. Git is always the source of truth and we
re-read rather than reconcile.

**A project is not required to be a repository.** A plain folder is a valid
project; it simply cannot offer worktree-backed sessions. This is what stops
"add project" from being a git-shaped question.

### `ProjectSettings`

The only per-scope settings that exist. Everything else is global.

```swift
public struct ProjectSettings: Hashable, Sendable, Codable {
    public var worktreeRoot: WorktreeRoot        // where new worktrees are placed
    public var automation: [AutomationCommand]   // see below
    public var defaultProfileID: LaunchProfileID?
    public var forge: ForgeSettings              // enabled, host override
}
```

Per-*project* settings earn their place because a project is where the differences
actually live: one repo needs `pnpm install`, another needs a Python venv, a third
needs neither. Per-*session* settings do not, and adding them would mean
revisiting that split here first.

---

## Session

> **A directory with terminals in it.**

The thing a user switches between, and the object the sidebar is a list of.

```swift
public struct Session: Identifiable, Hashable, Sendable, Codable {
    public let id: SessionID
    public var projectID: ProjectID?       // nil ⇒ standalone
    public var name: String
    public var directory: URL              // the working directory. Centre of gravity.
    public var backing: Backing            // how that directory came to exist
    public var terminals: [TerminalDescriptor]
    public var layout: SessionLayout       // tabs and splits over those terminals
    public var accent: Accent
    public var createdAt: Date
    public var lastActiveAt: Date
    public var isPinned: Bool
}
```

**Names need not be unique.** People are bad at unique names and we do not need
them to be — identity is the `SessionID`.

**The directory is the centre of gravity.** It is where terminals open. It may be a
plain folder, a project's own checkout, or a worktree; the `Session` type does not
change shape between those cases.

**`projectID` is optional, and that is load-bearing.** A standalone session is not
a lesser session. It has no automation, no worktree option, and no forge state,
because it has no project to get them from — nothing else differs.

### `Session.Backing` — the one place worktrees exist

```swift
public enum Backing: Hashable, Sendable, Codable {
    case projectDirectory                  // simple session: runs in the project's directory
    case folder                            // standalone: a directory the user picked
    case worktree(WorktreeBinding)         // worktree-backed session
}
```

Backing records **how the directory came to exist**. It is provenance, not a
category of session, and that distinction is the product thesis expressed as a
type. There is no `Session.isWorktree` flag, no separate worktree list, and no
second creation flow.

Two invariants the type enforces and `SessionBackingTests` pins down:

| Backing | `projectID` | May delete the directory |
| --- | --- | --- |
| `.folder` | must be `nil` | never |
| `.projectDirectory` | must be non-`nil` | never — it is the user's checkout |
| `.worktree` | must be non-`nil` | only when `ownership == .managed` |

### `WorktreeBinding`

A small value tying a session's directory to the repository and branch it was cut
from.

```swift
public struct WorktreeBinding: Hashable, Sendable, Codable {
    public var branch: String?          // nil when detached
    public var baseCommit: String?
    public var path: URL
    public var ownership: Ownership     // .managed | .adopted
    public var includedPaths: [String]  // what .worktreeinclude copied in
}
```

It is a value type rather than an entity because **a worktree has no independent
lifecycle in Janela**. It is created with a session and dies with it. Giving it an
identity would be the first step back toward a worktree-centric model.

`ownership` exists for exactly one reason: **safety**. `.managed` means Janela
created the worktree, so Janela may offer to remove it. `.adopted` means it existed
before us, and we do not get to destroy it on a hunch.

`includedPaths` is what `.worktreeinclude` actually copied, recorded at creation
time rather than recomputed at deletion time. It is how the removal dialog can say
"this will also delete a 400 MB `node_modules` that was copied in, and an `.env`
that exists nowhere else".

### Creating one

There is exactly one public entry point,
`SessionStore.createSession(_:)`, taking a `SessionCreationRequest`:

```swift
public enum SessionCreationRequest: Sendable {
    case standalone(directory: URL, name: String?)
    case inProject(ProjectID, name: String?)
    case newWorktree(project: ProjectID, branch: String, startPoint: String?,
                     directory: URL?, name: String?)
    case adoptWorktree(project: ProjectID, directory: URL, name: String?)
    case fromPullRequest(project: ProjectID, reference: PullRequestReference)
}
```

Worktree creation is *one case of that function*, not a separate feature with its
own screen. If a second public creation method ever appears, the worktree-centric
model has crept back in.

---

## Terminal

> **One PTY, one child process, one emulator.**

Note the split, which mirrors the old session/descriptor split one level down:

- **`TerminalDescriptor`** (`JanelaCore`) — the part we can write to disk: `title`,
  optional `profileID`, optional working-directory override, `startsAutomatically`,
  and `role`. Shared by both processes.
- **`LiveTerminal`** (`JanelaTerminal`, **daemon only**) — the live object, holding a
  file descriptor, a child process and the authoritative grid. Named `LiveTerminal`
  rather than `Terminal` because SwiftTerm already exports a `Terminal`, and the
  collision would be resolved by whoever imports last.
- **`TerminalMirror`** (`JanelaClient`, **client only**) — what a client knows about
  a terminal: its descriptor, its last-reported state, and whether this client is
  attached. It has no PTY and cannot start anything; it is a view of a fact owned in
  another process.

That separation is what lets `JanelaCore` stay free of I/O, and it is what makes
"restore my layout" mean "restore descriptors", not "restart everyone's shells".

### `TerminalRole`

```swift
public enum TerminalRole: Hashable, Sendable, Codable {
    case user                       // the user asked for it
    case automation(AutomationEvent) // a project command runs here
}
```

Automation terminals are ordinary terminals with a label. They are not a hidden
process with a bespoke output view.

### `TerminalState`

```swift
public enum TerminalState: Hashable, Sendable {
    case idle                    // configured, nothing spawned. Costs ~nothing.
    case running
    case needsAttention          // the terminal asked for it
    case exited(code: Int32)
    case failed(message: String)
}
```

`.idle` is a first-class state, not an absence. It is what makes 40 open terminals
cheap, and it is why allocation happens in `start()` rather than `init`.

**There is no `.waitingForUser` or `.agentThinking`**, and adding one would mean
reversing a deliberate decision rather than filling a gap. Janela reports what
the *terminal* told it — BEL, OSC 9/777, OSC 133 — and never infers agent
semantics from a byte stream.

A session's status is **derived** from its terminals, never stored: a session is
running if any terminal is running, and wants attention if any unfocused terminal
does. Storing it would create two sources of truth for the thing the sidebar is
judged on.

The daemon computes `TerminalState` and pushes it; clients render what they were
told. A client that *infers* state — "I sent input, so it must be running" — is a
bug, because the process it is guessing about lives elsewhere and may have exited a
second ago.

---

## `SessionLayout` — tabs and splits

A session arranges its terminals. The arrangement is per-session state, persisted
with the session, not a saved object the user manages.

```swift
public struct SessionLayout: Hashable, Sendable, Codable {
    public var tabs: [Tab]
    public var focusedTabIndex: Int

    public struct Tab: Hashable, Sendable, Codable {
        public var title: String?          // nil ⇒ derive from the focused terminal
        public var root: Pane
        public var focusedTerminalID: TerminalID
    }

    public indirect enum Pane: Hashable, Sendable, Codable {
        case terminal(TerminalID)
        case split(axis: Axis, fraction: Double, first: Pane, second: Pane)
    }
}
```

Design constraints, all of them enforceable and tested:

- **Every `TerminalID` in the tree exists in `session.terminals`, exactly once.**
  A layout referencing a dead terminal is a corrupt layout; loading repairs it by
  dropping the pane rather than by failing.
- **`fraction` is clamped to `0.05...0.95`.** A pane you cannot see is a pane you
  cannot close.
- **Depth is bounded at 6.** Deeper is not a workflow, it is a misclick, and an
  unbounded recursive `Codable` type is a decoding hazard.
- **Closing a terminal collapses its split**, promoting the sibling. Closing the
  last terminal in a tab closes the tab; closing the last tab leaves the session
  with one idle terminal, not zero.

Why this is modelled at all, when the old model refused to model layout: splits and
tabs are v1 scope, and "wherever you left it" only works if "where you left it"
is written down.

---

## Launch profile

A named thing you can start in a terminal: `name`, `symbolName`, `command` and
`environment`.

`command` is an **argument array, not a shell string**. We never hand user input
to `sh -c`, so the quoting bug class does not exist here. An empty `command` means
"the user's login shell", resolved at launch.

`isAgent` is **purely presentational** — a different tab icon, inclusion in
"notify me when agents finish". It grants no special behaviour, because agents get
no special behaviour.

Built-ins ship for Shell, Claude Code, Codex and OpenCode. These are *suggestions,
not integrations*: if the binary is not on the user's `PATH`, the profile is hidden
rather than shown broken. Adding one must never require code changes elsewhere.

---

## Values that hang off the nouns

These are not concepts a user learns. They are fields.

### `AutomationCommand`

```swift
public struct AutomationCommand: Identifiable, Hashable, Sendable, Codable {
    public let id: AutomationID
    public var event: AutomationEvent
    public var command: [String]          // argv, never a shell string
    public var isEnabled: Bool
    public var timeout: Duration          // teardown only; default 30 s
}

public enum AutomationEvent: String, Hashable, Sendable, Codable, CaseIterable {
    case worktreeCreated    // a managed worktree exists and .worktreeinclude has run
    case sessionStart       // a session in this project is opened for the first time
    case sessionTeardown    // the user asked to delete the session
}
```

Ordering when creating a worktree-backed session is fixed and documented because
scripts depend on it:

```text
git worktree add
   ↓
.worktreeinclude copy          (files are in place before anything runs)
   ↓
.worktreeCreated commands      (install dependencies, generate config)
   ↓
.sessionStart commands         (start the dev server)
   ↓
the user's own terminals
```

Each command runs in a terminal with `role == .automation(event)`, in the session's
directory, with the session's environment. Failure is visible and non-fatal:
the terminal stays open showing a non-zero exit, and the session is still usable.
Teardown is the one exception — deletion waits for it, bounded by `timeout`.

These live in Janela's database rather than in a committed repo file.

### `ForgeState`

Read-only, cached, per-session, and derived from the session's branch:

```swift
public struct ForgeState: Hashable, Sendable, Codable {
    public var host: Forge                       // .gitHub | .gitLab
    public var pullRequest: PullRequestSummary?  // number, title, state, isDraft, url
    public var checks: CheckRollup?              // .passing | .failing | .running | .none
    public var refreshedAt: Date
}
```

It is a cache with a timestamp, never a source of truth, and every field is
optional because `gh` may be missing, logged out, rate-limited, or pointed at an
enterprise host we cannot reach. Absence renders as absence, never as an error
banner.

### `AttentionSignal`

What a terminal reported, normalised, before any policy is applied:

```swift
public struct AttentionSignal: Hashable, Sendable {
    public enum Kind { case bell, notification(title: String?, body: String), promptFinished(exitCode: Int32?) }
    public var kind: Kind
    public var terminalID: TerminalID
    public var at: Date
}
```

The signal is a fact, produced by the daemon's emulator and pushed to every
subscribed client. Whether it becomes a badge, a Notification Centre delivery, or
nothing at all is policy — and policy lives in `JanelaClient`, because only a client
knows what is focused and whether anyone is looking.

---

## Deliberately absent

Each of these was considered and rejected. Adding one is a change to this model,
and belongs here before it belongs in code.

| Not modelled | Why |
| --- | --- |
| **Workspace** | Retired vocabulary. What it used to mean is now a `Session`; what people usually mean by it is a `Project`. Using it in new code or copy is a bug. |
| **Worktree as an entity** | It has no independent lifecycle. It is provenance on a session. |
| **Nested projects / folders / tags** | The sidebar is two levels. Hierarchy past that is a cost users pay to organise something they mostly search. |
| **Task / run / job** | A running thing is a terminal. Automation is a command with an event, not a job with a queue. |
| **Agent** | An agent is a launch profile that happens to be an agent. |
| **Per-session settings** | Settings are global or per-project. Sessions carry state, not configuration. |
| **Saved layouts** | The layout is wherever you left it, stored on the session. Not a named object with its own management UI. |
| **Pull request / issue as an entity** | `ForgeState` is a cache on a session. We do not own forge objects and must never look like we do. |
| **Scrollback** | Lives in the daemon emulator's ring buffer and dies with the terminal. Persisting it is unbounded growth plus a privacy problem — and it now survives the *app* closing, which is what people actually wanted. |
| **Client / device** | A connection is not a domain object. The daemon tracks which connections are attached to what, and that state dies with the socket. Naming and persisting devices is a sync feature, and we do not have one. |
| **Terminal grid** | Not in `JanelaCore`. The authoritative grid is `JanelaTerminal`'s private business and reaches clients as escape sequences, never as a modelled type. A cell grid in the domain layer would invite a second renderer format. |

---

## Vocabulary

Use these words consistently; the mismatch between UI copy and code names is how a
model erodes.

| Say | Not |
| --- | --- |
| project | repository, workspace, group, folder |
| session | workspace, worktree, tab, window |
| terminal | pane, shell, tab, session |
| tab | window, view |
| split | pane, division |
| launch profile | agent, command, tool, preset |
| directory | folder, path, cwd |
| automation command | hook, script, task, job |
| daemon, `janelad` | server, backend, service, agent |
| client | frontend, UI (when you mean the process) |
| attach / detach | connect, open, subscribe (when you mean one terminal) |
| connect / disconnect | attach (when you mean the socket) |

Two of these are worth stating twice, because they are the ones that will slip:

- **A tab belongs to a session and holds terminals.** It is not a session and it is
  not a terminal.
- **"Workspace" means nothing here.** If a sentence needs it, the sentence is
  describing either a project or a session and has not decided which.
