# 0009. Projects contain sessions; sessions contain terminals

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

Janela's original model had one central noun. A *workspace* was a named directory
with terminals in it; a *session* was a single terminal; and there was no grouping
of any kind, on the argument that hierarchy is a tax users pay to organise
something they mostly search.

Building the sidebar against that model exposed three problems.

**1. A flat list does not survive worktrees.** The whole point of the app is that
creating a branch is cheap. A developer working on one repository across four
branches gets four entries; three repositories like that is twelve, interleaved by
recency, distinguishable only by name. The feature that makes the app good is the
feature that makes its navigation bad. Grouping is not organisational
decoration here — it is the direct consequence of the primary workflow.

**2. "A terminal" is the wrong unit of switching.** In practice a place of work is
an agent, a dev server, and a scratch shell. The user switches between *places*,
not between terminals, and every existing tool in the space agrees: tmux windows
hold panes, iTerm tabs hold splits, VS Code terminals are a group. Modelling a
session as exactly one terminal pushed splits and tabs out of the model and into
the view, where they could not be persisted or reasoned about.

**3. Per-project behaviour had nowhere to live.** Setup commands, worktree
placement, `.worktreeinclude`, forge configuration — all of these are properties of
a repository, and all of them were homeless in a model whose only entity above a
directory was a global settings screen.

The counter-argument, and it was a good one, is the concept budget: four nouns,
and every addition is a tax.

## Decision

Three levels, and exactly three:

```text
Project  →  Session  →  Terminal
```

- A **Project** is a directory the user added — usually a repository. It groups
  sessions, and it owns the per-repository settings: worktree placement,
  automation commands, forge configuration.
- A **Session** is a named directory with terminals in it. It is the unit of
  switching and the object the sidebar lists. Its `projectID` is **optional**: a
  standalone session belongs to no project.
- A **Terminal** is one PTY, one child process, one emulator. Sessions arrange
  their terminals in tabs and splits ([ADR 0010](0010-terminal-layout.md)).

The concept budget is unchanged at four, because **`Repository` was absorbed into
`Project`** and **`Workspace` was renamed to `Session`**. What used to be
`Workspace` is now `Session`; what used to be `Session` is now `Terminal`; what
used to be `Repository` is now the git-shaped half of `Project`.

Worktree-ness stays exactly where it was, one level down: `Session.Backing` is
`.projectDirectory`, `.folder`, or `.worktree(WorktreeBinding)`. There is still one
creation entry point, `SessionStore.createSession(_:)`, and worktree creation is
still one case of it.

Hard limits that stop this becoming a tree:

- **Two levels of containment. Never three.** No nested projects, no session
  groups, no folders, no tags.
- **A project's session list is flat and ordered by the user.**
- **Standalone sessions are a first-class case**, rendered above the projects, not
  a fake "Ungrouped" project.

`JanelaWorkspace` is renamed `JanelaSession`, and "workspace" is removed from the
vocabulary entirely — see [`../domain-model.md`](../domain-model.md) § Vocabulary.

## Consequences

**Good.** The sidebar matches the workflow: collapse a repository you are not
working in today and it costs one row. Navigation stays a list of buttons, which
is what keyboard navigation and a fuzzy jump list both want.

**Good.** Splits and tabs, automation, and forge state all have an obvious owner.
None of them needed a new top-level concept, which is the test of whether the
hierarchy was the right one.

**Good.** The rename removes a genuine ambiguity. "Workspace" meant a directory
here, a repository in VS Code, a monorepo package in pnpm, and an Xcode file
format. It was never going to survive contact with users.

**Bad.** It is one more level than the original design, and one more decision at
creation time: project or standalone. Mitigated by making the answer obvious from
where the action was taken — the `+` on a project creates in that project, the one
in the toolbar creates standalone.

**Bad.** A large rename through a scaffolded codebase and every document. Done in
one commit, before there are users, which is the cheapest this will ever be.

**Bad.** Two levels invites a request for three within a month. The limit is
written here so the answer is a link rather than a discussion.

## Alternatives considered

**Keep the flat list, add search.** The original position, and defensible: a fuzzy
jump list makes any list navigable. Rejected because it optimises the *recall* case
and ignores the *survey* case — "what am I in the middle of?" is a question you
answer by looking, and twelve interleaved rows do not answer it. We ship the jump
list anyway; it is complementary, not a substitute.

**Keep the flat list, add tags.** More flexible than grouping and strictly worse
here: tags are many-to-many, so they cannot render as a collapsible tree, and the
one grouping users actually want — by repository — is already implied by the data.
We would be asking users to hand-maintain a fact we already know.

**Projects only, no standalone sessions.** Simpler model, one code path. Rejected
because "give me a terminal in this folder" is a real and frequent use, and forcing
it to invent a project first is exactly the kind of ceremony this app exists to
remove.

**Sessions contain sessions (arbitrary nesting).** Rejected without much
deliberation: it is a file manager, it makes every operation recursive, and no
user has ever asked a terminal app for a folder tree.

**Terminal as the unit of switching, splits as pure view state.** The original
model. Rejected on persistence: a layout that cannot be saved is a layout the user
rebuilds after every restart, and the app's whole claim is that returning to a
place is free.

## Revisit when

- Users with a single repository report the project level as pure overhead — the
  fix would be auto-collapsing to a flat list when there is exactly one project,
  not a model change.
- Someone produces a concrete workflow that a third level would serve, together
  with the rendering and keyboard-navigation story for it.
