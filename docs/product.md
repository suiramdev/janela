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
- **Multiplexers** (`tmux`, `zellij`) solve arrangement, but every switch is a
  keystroke chord you have to remember, and creating a worktree to work on a second
  branch is still a five-command chore you do by hand.

Neither is wrong. But there is a gap between them, and it is where most of a
developer's day with agents actually happens: *starting a second, third and fourth
place to work, and moving between them without losing the thread.*

---

## The thesis

> **A session is a directory with terminals in it. A project is where sessions
> come from.**

That is the entire mental model, and it maps one-to-one onto what you see:

```text
Project          collapsible in the sidebar — a repository or folder you added
  └─ Session     a button — one working directory, one or more terminals
       └─ Terminal   a shell, an agent, a dev server; split and tabbed
```

Two sentences of consequence:

- **A session does not need a project.** "Just give me a terminal in this folder"
  is a standalone session, and it is a first-class case, not a degenerate one.
- **A session inside a project can bring its own directory.** A *simple* session
  runs in the project's own directory. A *worktree-backed* session gets a fresh git
  worktree created for it, which is how you work on a second branch without
  stashing, cloning, or thinking about `git worktree add`.

The worktree is an implementation detail of *how a session's directory came to
exist*. It is modelled as `Session.Backing`, and that is the only place
worktree-ness enters the domain. There is no `Worktree` screen, no worktree list,
no separate type.

**This is the differentiator.** Not "we support worktrees" — plenty of tools do. It
is that a worktree costs one action to create, one click to return to, and one
confirmation to destroy, and that in between it behaves exactly like every other
place you work.

---

## Principles

### 1. Simple by design

Every concept a user must learn is a tax. Janela's concept budget:

| Concept | Why it earns its place |
| --- | --- |
| **Project** | The thing you add once so that "new branch" and "run the setup script" are one step. |
| **Session** | The thing you switch between. Unavoidable. |
| **Terminal** | A running program. Unavoidable. |

That is three. Adding a fourth requires deleting one, or an argument written down
here for why the tax is worth it.

Note what the hierarchy is *not*: arbitrary nesting. It is exactly two levels deep,
always, and the second level is flat. Sessions do not contain sessions, projects do
not contain projects, and there are no folders, tags, or saved groups. Two levels
is what a sidebar can render as a list of buttons and what a user can hold in their
head; three is a file manager.

Rejected concepts, and why: tasks/runs/jobs (a running thing is a terminal);
per-session settings trees (settings are global or per-project, sessions carry
state); saved layouts as objects (a session's layout is wherever you left it, and
it lives on the session).

### 2. Terminal-first, and we do not replace your tools

Janela runs your shell, your git, your agents, your `gh`. It does not:

- reimplement a shell, or parse your dotfiles
- wrap `claude`/`codex`/`opencode` in a custom protocol
- provide a text editor, a diff viewer, or a file tree
- model an agent's task graph or transcript
- implement its own git plumbing, GitHub client, or credential store

If a feature request starts with "Janela should understand…", the answer is
almost certainly no. The value is in *arrangement*, not in *interpretation*.

The sharp edge of this principle: Janela reports what the **terminal** told it —
OSC 9 notifications, OSC 133 prompt marks, the bell — and never guesses agent
semantics from a byte stream.

What that admits, and what it still refuses. A harness — Claude Code, Codex,
OpenCode, Oh My Pi — may now *tell* the terminal what it is doing: working,
waiting for permission, waiting for an answer, finished, or stopped with an
error. It says so with one escape sequence, exactly as a build says how far
along it is with `OSC 9 ; 4`, and Janela relays the claim without checking it.
Janela installs the hook that makes a harness say so only when the user asks for
it, in Settings › Integrations › Activity reporting, and installs it in the
harness's *own* configuration — Claude Code's `settings.json` hooks, Codex's
`hooks.json` plus the trust entries `config.toml` needs, an OpenCode plugin, an
Oh My Pi extension. What lands there is short and readable: one line of shell
for Claude Code and Codex, a small plugin file for the other two. It is also
inert outside Janela, because it writes to `$JANELA_TTY`, a variable that exists
only in a terminal this app spawned — the same agent started from Terminal.app
or over SSH runs the hook, finds nothing, and exits.

Nothing else moved. Janela does not read transcripts or session files, does not
parse a harness's output, does not guess from a window title or a prompt, and
models no task. Being *told* and reading *into* are different acts, and only the
first one happens here: an agent that says nothing is an agent Janela has
nothing to say about, which is the normal case and not a degraded one.

The same principle decides how Janela reaches the user's other tools. Forge
support shells out to the user's own `gh` and `glab`, already authenticated,
rather than asking for a token. Automation scripts run in a real terminal you
can watch, rather than in a hidden process whose output we invent a UI for.

### 3. Switching is the feature

The app is judged on one interaction, performed hundreds of times a day: getting
from where you are to where you want to be.

That means:

- **Every session is one click or one keystroke away.** The sidebar is the whole
  navigation model — projects collapse, sessions are buttons, and there is a fuzzy
  jump list for when the sidebar is long.
- **Switching starts no work.** It shows a view. Budget: one frame.
- **Nothing is modal.** Creating a session, a worktree, or a project never takes
  over the app while a script runs; automation runs in a terminal you can watch or
  ignore.
- **The state you need is on the button.** Which sessions are running, which one
  wants attention, which branch a session is on — and, where a harness reports
  it, which agent has finished and which is waiting for you — visible without
  opening it.

This is also why splits and tabs exist inside a session rather than at the top
level: an agent, its dev server and a scratch shell are one *place*, and they
should switch as one.

### 4. Native, and it should feel like it

macOS conventions are not decoration. A developer tool that ignores them costs its
users a small tax on every interaction. Sheets, the standard sidebar, real menu
commands, proper keyboard navigation, Notification Centre, Increase Contrast,
Reduce Motion, dark mode via semantic colours.

**What this costs now, stated honestly.** The client renders in a WebView, so
this principle is a requirement we meet by effort rather than one the framework
meets for us. The chrome macOS owns is still genuinely native — the menu bar,
notifications, file dialogs, the window — and `prefers-color-scheme`,
`prefers-contrast` and `prefers-reduced-motion` are the same three settings
under different names.

What is genuinely lost is AppKit's controls, and with them the last few percent:
scrollbar behaviour, text-field affordances, sheet physics, and the accumulated
correctness of controls we did not write. A WebView imitation of a macOS control is
usually close and occasionally wrong, and developers notice. That is a real cost,
paid deliberately, and the defence is discipline rather than optimism — the design
system stays small and closed instead of re-creating AppKit in CSS.

### 5. Fast enough that you stop noticing it

Specific budgets, not vibes, live in [`performance.md`](performance.md). The
headline ones:

- **Cold launch to interactive window: 400 ms.**
- **Session switch: one frame.** Switching is showing a view, not starting work.
- **40 open sessions is normal**, because an unstarted terminal costs ~nothing.
- Terminal throughput must survive `yes` and a verbose build without dropping the
  UI below 60 fps.

The launch number moved — it was 250 ms — and only the launch numbers moved. A
WebView process and a JavaScript bundle are a real cost, and keeping a budget we
would miss on every run would make the whole document decorative. Everything else is
unchanged, which is not luck: the daemon already took the expensive work off the
launch path and already absorbs the floods, so what renders does not affect them.
Measured, the terminal path has headroom — 133 MB/s off the PTY against a 100 MB/s
budget.

### 6. Laziness is a feature, and so is leaving

A configured terminal that has never been started costs a struct. A collapsed
project reads nothing from disk. A session you have not opened has no emulator, no
PTY, and no child process.

This is what makes the sidebar allowed to be long, and it is why
`Terminal.start()` — not `init` — is what allocates.

The same property applies at the other end. **Closing the window costs nothing
either.** Your agent keeps working, your dev server keeps serving, and reopening
puts you back where you were, scrollback intact. A background daemon owns the
processes, so quitting Janela is not a decision about your work.

Which is a promise that has to be visible from outside the window, so the daemon
keeps a menu bar item: show Janela, quit it, or stop the daemon on purpose. It is
the only place that says work is still running when nothing of Janela is on screen,
and stopping the daemon from there asks the same question with the same counts as
anywhere else.

The honest limit: this survives the app, not the machine. Logging out or rebooting
ends your terminals, and sessions come back idle.

### 7. Destructive actions explain themselves

Deleting a session can delete a worktree, which can lose work. So Janela computes
what would actually be lost — uncommitted changes, unpushed commits, running
terminals, a lock held by another process, files copied in by
`.worktreeinclude` — and says so specifically. "Are you sure?" is not a warning.
See `WorktreeRemovalSafety`.

Deleting a project is the same question asked once per session it owns.

---

## What v1 includes

Committed scope. Each has a design section in
[`domain-model.md`](domain-model.md).

| Capability | Shape |
| --- | --- |
| **Projects and sessions** | Sidebar with collapsible projects, sessions as buttons, standalone sessions above them |
| **Worktree-backed sessions** | "New Session" creates the worktree, on a branch you pick or one you name; removal explains what it destroys |
| **Splits and tabs** | Terminals arranged in a per-session layout tree, persisted |
| **Notifications** | Terminal-signalled attention, badged in the sidebar and delivered to Notification Centre when you are elsewhere |
| **GitHub / GitLab** | Branch and PR/MR state on a session, "new session from PR", via the user's `gh`/`glab` |
| **Inbox** | One page for the sessions that want you and the issues and pull/merge requests of your projects, filterable, each opening in the browser |
| **`.worktreeinclude`** | Repo-declared list of ignored files to carry into a new worktree — `.env`, `node_modules`, build caches |
| **Project automation** | Commands on session start, session teardown, and worktree creation |
| **Durable sessions** | A daemon owns the processes, so quitting the app does not stop them |

The last one is also the foundation for two things that are **not** v1 scope, listed
here so their absence reads as a plan rather than an oversight: a `janela` CLI — so
an agent can list sessions, read what is on a terminal's screen, or start work — and
connecting to your own Mac from a phone. Both are clients of the same protocol, and
neither needs an architecture change to add, which is precisely why the daemon
arrived now rather than later.

Since the client became a WebView, the second one has arrived in its first form: the
same views run as a browser page (`apps/web`) over a WebSocket to a gateway on the
Mac (`apps/gateway`), sharing the mirror and the terminal surface with the desktop
app rather than reimplementing them, and reached from another device through your
own tailnet. The phone client proper is that page on a phone. Choosing a folder
there is the daemon's job — it lists one folder at a time for a Finder-like column
view — and the affordances only the Mac can offer — Finder, Terminal.app,
`launchctl` — simply are not drawn. Still nothing runs anywhere but your machine.

---

## Non-goals

Listed so they can be pointed at, not re-litigated.

- **Not a code editor.** No editing surface, ever. Your editor is better.
- **Not a git client.** Worktree plumbing and read-only status. No staging UI, no
  commit UI, no rebase assistant, no history browser.
- **Not a forge client.** We show the state of the branch a session is on, list
  a project's issues and pull requests in the Inbox by number, title and status,
  and can start a session from a PR. Each one opens in the browser; Janela never
  shows a pull request's content. No review UI, no comment threads, no merge
  button.
- **Not an agent runtime.** Janela does not schedule agents, retry them, chain
  them, or read their output for meaning. It does listen to what an agent says
  about itself, through a hook the agent runs — a report it volunteers, never an
  interpretation we take.
- **Not a multiplexer replacement.** We took exactly one thing from tmux — sessions
  that outlive their client — and deliberately left the rest: no scripting language,
  no config file, no session sharing between users, and no key-binding surface
  competing with the program you are running. If you want tmux, run tmux — it works
  fine inside Janela, which is the correct relationship.
- **Not a task runner.** Project automation is three lifecycle events with a
  command each. It is not a build system, it has no dependency graph, and it will
  not grow one.
- **Not cross-platform *yet*, and macOS is still the point.** macOS is the only
  platform we build, test, ship or support, and no bug is a bug because it appears
  elsewhere. What changed is the cost of the door: the client renders in a WebView
  and the daemon speaks a transport-agnostic protocol, so reaching a browser — which
  is what "connect to your Mac from a phone" was always going to mean — is a
  transport implementation rather than a second codebase. We spend nothing to keep
  that door open and refuse changes that would close it. Shipping Linux or Windows
  would be a testing and support commitment nobody has asked for, and it is the
  fastest route to "runs everywhere, feels like nowhere"; that answer is still no,
  and reversing it is an architecture decision to write down in
  [`architecture.md`](architecture.md) first, not a feature request.
- **Not collaborative.** No accounts, no sync, no sharing. A future remote client
  connects *you* to *your own Mac*; it does not connect you to anyone else, and
  nothing about it implies a server we operate.
- **Not a cloud product.** Your code stays on your machine. The daemon is a local
  process, and remote access — when it exists — is a connection to your hardware,
  not an upload to ours.
- **Not a service you leave running for its own sake.** The daemon starts when a
  client first connects and exits when it has nothing left to hold.
- **Not a plugin platform.** Extensibility is the fastest route to the complexity
  this app exists to avoid.
- **No telemetry.** The app does not phone home.

---

## What "done" looks like for v1

A developer can:

1. Add a repository as a project once.
2. Press `⌘N`, type a branch name that does not exist yet, and be looking at a
   terminal in a fresh worktree seconds later — with their `.env` already in
   place and `pnpm install` already running, because the project said so.
3. Press `⌘T` and have a shell in the right directory with their real `PATH`.
   Split the pane, start `claude` in one half and a dev server in the other.
4. Switch to another session instantly, and be told — in the sidebar, and in
   Notification Centre if Janela is not frontmost — when the first one wants
   attention.
5. See that the branch they are on has an open pull request, and that CI is red.
6. Quit Janela with the agent still working, reopen an hour later, and find it
   finished, the dev server still up, and the scrollback intact.
7. Finish, delete the session, and be told exactly what that will destroy before it
   happens.

Nothing in that list requires the user to think about worktrees, nothing in it
required them to leave the app to run a setup script, and nothing in it punished
them for closing a window. That is the test.
