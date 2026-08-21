# Janela

> [!WARNING]
> **This document predates the Tauri/TypeScript migration and is stale.**
> It describes the Swift stack — `make` targets, SwiftPM modules, SwiftTerm, GRDB,
> Xcode. The architecture, the domain model and the product thesis it serves are
> unchanged; the stack it names is gone.
>
> Current: [`AGENTS.md`](AGENTS.md) for commands and layering,
> [`architecture.md`](docs/architecture.md) for the system,
> [`MIGRATION_MAP.md`](docs/MIGRATION_MAP.md) for where every module, type and seam went.
> Rewriting this file is a tracked follow-up.


**A native macOS terminal session manager. Terminal-first, worktree-aware,
deliberately small.**

---

Janela manages the places you work. Add a repository once, press a key, and you
have a fresh branch in a fresh worktree with your `.env` already in place, `pnpm
install` already running, and Claude Code waiting in a terminal — without ever
thinking about `git worktree add`.

> **A session is a directory with terminals in it.**
> **A project is where sessions come from.**
>
> That is the whole model.

```text
Project          collapsible in the sidebar — a repository or folder you added
  └─ Session     a button — one working directory, one or more terminals
       └─ Terminal   a shell, an agent, a dev server; split and tabbed
```

Sessions can also stand alone, with no project at all — "just give me a terminal in
this folder" is a first-class case, not an afterthought.

And they keep running when you close the window. A small background daemon owns the
processes, so quitting Janela is not a decision about your work.

---

## Why

Working with coding agents means juggling terminals. A branch here, a worktree
there, an agent running in one tab, a dev server in another, and no reliable sense
of which of the six things you started is still alive or wants something.

Terminal emulators are great at terminals and know nothing about your
repositories. Multiplexers solve arrangement but make you memorise chords, and
still leave creating a worktree as a five-command chore.

Janela sits in the gap. It is `tmux`-shaped ergonomics — many places to work, one
keystroke between them — with the git worktree friction removed and none of the
configuration.

## What it is

- **Native.** Swift, SwiftUI, AppKit where it earns its place. Not Electron.
- **Fast.** Budgeted, not hand-waved: 250 ms cold launch, one-frame session
  switching, 40 open sessions comfortably. See [`docs/performance.md`](docs/performance.md).
- **Terminal-first.** It runs your shell, your git, your agents, your `gh`. It does
  not reimplement, wrap, or interpret them.
- **Agent-friendly.** Claude Code, Codex, OpenCode and anything else that runs in
  a terminal. No per-agent integrations, because there is nothing to integrate.
- **Small.** Four concepts: project, session, terminal, launch profile.
- **Durable.** Terminals live in a daemon, not in the window. Close the app, come
  back tomorrow, find your agent finished and your dev server still up.

### v1 scope

| Capability | Shape |
| --- | --- |
| Projects and sessions | Collapsible projects, sessions as buttons, standalone sessions too |
| Worktree-backed sessions | One action to create, one confirmation — that explains itself — to destroy |
| Splits and tabs | Terminals arranged per session, persisted where you left them |
| Notifications | Sidebar badges from real terminal signals, plus Notification Centre when you are elsewhere |
| GitHub / GitLab | PR and CI state for a session's branch, and "new session from PR", via your own `gh`/`glab` |
| `.worktreeinclude` | Carry `.env`, `node_modules` and friends into a new worktree |
| Project automation | Commands on worktree creation, session start, and session teardown |
| Durable sessions | A daemon owns the processes; the app is one of its clients |

The daemon is also the foundation for two things explicitly **not** in v1: a
`janela` CLI for agent skills, and connecting to your own Mac from a phone. Both are
clients of a protocol that already exists.

## What it is not

Not a code editor. Not a git client. Not a forge client. Not an agent runtime. Not
a multiplexer replacement. Not a task runner. Not cross-platform. Not a plugin
platform. No telemetry.

The reasoning for each is in [`docs/product.md`](docs/product.md) § Non-goals —
written down so they can be pointed at rather than re-litigated.

---

## Status

> **Scaffolded, not implemented.**
>
> The repository builds, launches, and passes its tests. The architecture,
> module boundaries, domain model and decisions are settled and documented. The
> behaviour behind them is `TODO`.

If you are picking this up, start at [`docs/development.md`](docs/development.md)
§ First tasks. `grep -rn "TODO:" Packages/` is the work queue, and every stub has
a doc comment describing what belongs there.

## Getting started

```bash
make bootstrap    # verify Xcode, install XcodeGen, resolve deps, generate project
make test         # fast module tests
make open         # regenerate and open in Xcode
```

Requires macOS 15+, Xcode 26+. Run `make help` for everything else.

## Architecture at a glance

Two processes. `janelad` owns the PTYs, an authoritative terminal grid, the
database, git and automation; `Janela.app` renders, and is one client among several.
They meet at a framed Unix socket.

```text
Janela.app  ── unix socket ──  janelad
  JanelaClient                    JanelaDaemon
  JanelaTerminalUI                JanelaSession → Terminal → { Git, PTY, Persistence }
  JanelaUI / JanelaDesign
            ↖                  ↗
         JanelaCore + JanelaProtocol   (shared, pure)
```

All logic lives in `Packages/JanelaKit` as layered modules whose dependencies point
strictly downward, and no client module may import a daemon module — enforced by the
compiler, not by review. The app target is one Swift file; `Janela.xcodeproj` is
generated from `project.yml` and never committed.

Why a daemon, and what it costs:
[`docs/decisions/0015-daemon-owned-sessions.md`](docs/decisions/0015-daemon-owned-sessions.md).

## Documentation

| Document | What it answers |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | **Start here.** Rules for contributors and coding agents |
| [`docs/product.md`](docs/product.md) | What we are building and what we refuse to build |
| [`docs/architecture.md`](docs/architecture.md) | How it fits together and where the seams are |
| [`docs/domain-model.md`](docs/domain-model.md) | The four nouns and the shared vocabulary |
| [`docs/decisions/`](docs/decisions/) | ADRs — why the stack and the model are what they are |
| [`docs/conventions.md`](docs/conventions.md) | How the code is written |
| [`docs/testing.md`](docs/testing.md) | What we test, and what we refuse to fake |
| [`docs/performance.md`](docs/performance.md) | Budgets and how to measure them |
| [`docs/development.md`](docs/development.md) | Setup, the loop, and what to build first |
| [`docs/research/`](docs/research/) | Primary-source research behind the decisions |

## Prior art

Janela owes ideas to [cmux](https://github.com/manaflow-ai/cmux),
[Orca](https://github.com/stablyai/orca) and
[Superset](https://github.com/superset-sh/superset). A primary-source teardown of
all three, including what we took and what we deliberately did not, is in
[`docs/research/prior-art.md`](docs/research/prior-art.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
