# Domain model

The nouns, what they mean, and — as importantly — what they deliberately do not
mean. This is the shared vocabulary; use these words in code, in UI copy, and in
issues.

All types live in `JanelaCore` and are `Sendable` value types with no I/O.

---

## The whole model

```text
Repository ─────┐
  (a git repo   │ optional
   we know of)  │
                ▼
            Workspace ──────► Session ──────► LaunchProfile
         (named directory   (a terminal)    (a thing to run)
          + provenance)
```

Four nouns. That is the entire concept budget, and
[`product.md`](product.md) § 1 explains why adding a fifth is expensive.

---

## Workspace

> **A named directory with terminals in it.**

The central object and the only one a user must understand. `Workspace` holds a
`name`, a `directory`, an `origin`, its `sessions`, and some presentation state
(`accent`, `isPinned`, `lastActiveAt`).

**Names need not be unique.** People are bad at unique names and we do not need
them to be — identity is the `WorkspaceID`.

**The directory is the centre of gravity.** It is where terminals open. It may be
a plain folder, a repository checkout, or a worktree; the `Workspace` type does
not change shape between those cases.

### `Workspace.Origin` — the one place worktrees exist

```swift
case folder                                 // user picked a directory
case repositoryCheckout(RepositoryID)       // a repo's main checkout
case managedWorktree(WorktreeBinding)       // Janela created it
case adoptedWorktree(WorktreeBinding)       // it already existed
```

Origin records **how the directory came to exist**. It is provenance, not a
category of workspace, and that distinction is the product thesis expressed as a
type.

The `managed` / `adopted` split exists for exactly one reason: **safety**.
`ownsItsDirectory` is true only for `managedWorktree`, and it is what gates
offering to delete a directory from disk. We created it, so we may offer to remove
it. An adopted worktree existed before us and we do not get to destroy it on a
hunch.

`WorkspaceOriginTests` pins all of this down. If someone adds a `Workspace.isWorktree`
flag or splits `Workspace` into two types, those tests fail — deliberately.

---

## Repository

A git repository Janela has been shown at least once. Holds a display `name`, the
`mainWorktreeDirectory` (git's *main worktree*, not the common dir), and cached
`remoteURL` / `defaultBranch` for display.

**A repository is an index, not a container.** It exists so "new workspace from
branch X" is one step instead of a file picker. Consequences:

- Deleting a repository record never deletes workspaces.
- Workspaces can exist with no repository at all.
- Cached fields are for display only. **Git is always the source of truth**, and
  we re-read rather than reconcile.

### `WorktreeBinding`

A small value tying a workspace's directory to the repository and branch it was cut
from: `repositoryID`, `branch` (nil when detached), `baseCommit`, `path`.

It is a value type rather than an entity because **a worktree has no independent
lifecycle in Janela**. It is created with a workspace and dies with it. Giving it
an identity would be the first step back toward a worktree-centric model.

---

## Session (`TerminalSessionDescriptor`)

A terminal. The *persistable* description of one: `title`, an optional
`profileID`, an optional working-directory override, and `startsAutomatically`.

Note the split:

- **`TerminalSessionDescriptor`** (`JanelaCore`) — the part we can write to disk.
- **`TerminalSession`** (`JanelaTerminal`) — the live object, holding a file
  descriptor and a child process.

That separation is what lets `JanelaCore` stay free of I/O, and it is what makes
"restore my tabs" mean "restore descriptors", not "restart everyone's shells".

### `SessionState`

```swift
case idle                    // configured, nothing spawned. Costs ~nothing.
case running
case needsAttention          // the terminal asked for it
case exited(code: Int32)
case failed(message: String)
```

`.idle` is a first-class state, not an absence. It is what makes 40 open tabs
cheap, and it is why allocation happens in `start()` rather than `init`.

**There is no `.waitingForUser` or `.agentThinking`**, and adding one requires
superseding [ADR 0006](decisions/0006-agent-activity-signals.md). Janela reports
what the *terminal* told it — BEL, OSC 9/777, OSC 133 — and never infers agent
semantics from a byte stream.

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

## Deliberately absent

Each of these was considered and rejected. Adding one needs an ADR.

| Not modelled | Why |
| --- | --- |
| **Project / group / folder** | Workspaces are a flat, searchable list. Hierarchy is a cost users pay to organise something they mostly search. |
| **Task / run / job** | A running thing is a session. Nothing else. |
| **Worktree as an entity** | It has no independent lifecycle. It is provenance on a workspace. |
| **Agent** | An agent is a launch profile that happens to be an agent. |
| **Per-workspace settings** | Settings are global; workspaces carry state. |
| **Layout** | The layout is wherever you left it, not a saved object. |
| **Scrollback** | Lives in the emulator's ring buffer and dies with the session. Persisting it is unbounded growth plus a privacy problem. |

---

## Vocabulary

Use these words consistently; the mismatch between UI copy and code names is how a
model erodes.

| Say | Not |
| --- | --- |
| workspace | project, folder, tab, worktree |
| session | terminal, tab, pane, shell |
| launch profile | agent, command, tool, preset |
| repository | repo, project |
| directory | folder, path, cwd |
