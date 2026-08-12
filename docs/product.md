# Product direction

The document that settles arguments. Everything else in `docs/` describes *how*;
this describes *what* and, more importantly, *what not*.

---

## The problem

Developers working with coding agents end up juggling terminals. A branch here, a
worktree there, `claude` running in one tab, a dev server in another, and no
reliable sense of which of the six things they started is still alive or wants
something.

The existing answers pull in two unhelpful directions:

- **Terminal emulators** (Terminal.app, iTerm2, Ghostty, WezTerm) are excellent at
  terminals and know nothing about your repositories. Tab soup is on you.
- **Agent orchestrators** built around git worktrees make the worktree the central
  object. You end up managing worktrees as a first-class chore, which is a strange
  thing to ask of someone whose actual job is writing software. And when you just
  want a terminal in a folder, the model fights you.

Neither is wrong. But there is a gap between them.

---

## The thesis

> **A workspace is a named directory with terminals in it.**

That is the entire mental model. A user who understands that sentence can use
Janela without reading anything else.

Everything else attaches to it as *provenance* or *convenience*:

- A workspace's directory might be a folder you picked. Fine.
- It might be a repository's main checkout. Also fine.
- It might be a **git worktree Janela created for you** because you said "I want to
  work on a new branch". Still just a directory with terminals in it.

The worktree is an implementation detail of *how the directory came to exist*. It
is modelled as `Workspace.Origin`, and that is the only place worktree-ness enters
the domain. There is no `Worktree` screen, no worktree list, no separate type.

**This is the differentiator.** Not "we support worktrees" — everyone does. It is
that worktrees stopped being a thing you manage.

---

## Principles

### 1. Simple by design

Every concept a user must learn is a tax. Janela's concept budget:

| Concept | Why it earns its place |
| --- | --- |
| **Workspace** | The thing you switch between. Unavoidable. |
| **Session** | A terminal. Unavoidable. |
| **Repository** | Makes "new branch" a one-step action instead of a file picker. |
| **Launch profile** | Makes "start Claude Code here" a keystroke. |

That is four. Adding a fifth requires deleting one or writing an ADR that argues
why the tax is worth it.

Rejected concepts, and why: projects/groups (workspaces are a searchable flat
list — hierarchy is a cost users pay to organise something they mostly search);
tasks/runs/jobs (a running thing is a session); per-workspace settings trees
(settings are global, workspaces carry state); layouts as saved objects (the
layout is just where you left it).

### 2. Terminal-first, and we do not replace your tools

Janela runs your shell, your git, your agents. It does not:

- reimplement a shell, or parse your dotfiles
- wrap `claude`/`codex`/`opencode` in a custom protocol
- provide a text editor, a diff viewer, or a file tree
- model an agent's task graph or transcript

If a feature request starts with "Janela should understand…", the answer is
almost certainly no. The value is in *arrangement*, not in *interpretation*.

The sharp edge of this principle: Janela reports what the **terminal** told it —
OSC 9 notifications, OSC 133 prompt marks, the bell — and never guesses agent
semantics from a byte stream. See
[`decisions/0006-agent-activity-signals.md`](decisions/0006-agent-activity-signals.md).

### 3. Native, and it should feel like it

macOS conventions are not decoration. A developer tool that ignores them costs its
users a small tax on every interaction. Sheets, the standard sidebar, real menu
commands, proper keyboard navigation, Increase Contrast, Reduce Motion, dark mode
via semantic colours.

This is also why the app is Swift and AppKit/SwiftUI rather than a web stack: see
[`decisions/0004-terminal-engine.md`](decisions/0004-terminal-engine.md) for the
part of that argument that is measurable rather than aesthetic.

### 4. Fast enough that you stop noticing it

Specific budgets, not vibes, live in [`performance.md`](performance.md). The
headline ones:

- **Cold launch to interactive window: 250 ms.**
- **Workspace switch: one frame.** Switching is showing a view, not starting work.
- **40 open sessions is normal**, because an unstarted session costs ~nothing.
- Terminal throughput must survive `yes` and a verbose build without dropping the
  UI below 60 fps.

### 5. Destructive actions explain themselves

Deleting a workspace can delete a worktree, which can lose work. So Janela
computes what would actually be lost — uncommitted changes, unpushed commits,
running sessions, a lock held by another process — and says so specifically.
"Are you sure?" is not a warning. See `WorktreeRemovalSafety`.

---

## Non-goals

Listed so they can be pointed at, not re-litigated.

- **Not a code editor.** No editing surface, ever. Your editor is better.
- **Not a git client.** Worktree plumbing only. No staging UI, no commit UI, no
  rebase assistant, no history browser.
- **Not an agent runtime.** Janela does not schedule agents, retry them, chain
  them, or read their output for meaning.
- **Not cross-platform.** Native macOS is the point. Portability is a cost we are
  choosing to pay for depth. Revisit only with an ADR.
- **Not a terminal multiplexer.** If you want tmux, run tmux — it will work fine
  inside Janela, which is the correct relationship.
- **Not collaborative.** No accounts, no sync, no sharing in v1.
- **Not a plugin platform.** Extensibility is the fastest route to the complexity
  this app exists to avoid.
- **No telemetry.** The app does not phone home.

---

## What "done" looks like for v1

A developer can:

1. Point Janela at a repository once.
2. Press `⌘⇧B`, type a branch name, and be looking at a terminal in a fresh
   worktree seconds later.
3. Press `⌘T`, pick "Claude Code", and have it running in the right directory with
   their real `PATH`.
4. Switch to another workspace instantly, and be told when the first one wants
   attention.
5. Finish, delete the workspace, and be told exactly what that will destroy before
   it happens.

Nothing in that list requires the user to think about worktrees. That is the test.
