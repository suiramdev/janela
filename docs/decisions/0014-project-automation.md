# 0014. Automation commands live in Janela, and run in a visible terminal

- **Status:** Accepted
- **Date:** 2026-08-19
- **Amended:** 2026-08-26 by [0015](0015-daemon-owned-sessions.md) — automation runs
  in the daemon, so a dev server started by `.sessionStart` now outlives the window
  that started it. The three events and the no-repo-file rule are unchanged.

## Context

A new worktree needs setting up: install dependencies, generate a config, start a
dev server. A session being torn down may need the reverse: stop a container, drop
a database. Users do this by hand today, and doing it for them is most of the value
of the project concept.

Three questions, and the first one is a security decision rather than an
ergonomic one.

**Where does the command list live?**

The obvious answer is a committed file — `janela.toml` at the repo root, alongside
`.worktreeinclude`. It is shared with the team, versioned, reviewed. It is also, in
plain terms, **a file that makes cloning a repository execute arbitrary code on the
developer's machine.** Open a repo you were sent, create a session, and a command
you never read runs with your credentials, your SSH agent, and your `PATH`. This is
the same hazard that made VS Code build Workspace Trust and made `direnv` require
`direnv allow` per directory — both of which are prompts, and prompts for something
users want to say yes to are a formality they learn to click through.

The alternative is Janela's own database, edited in the app. Not shared with the
team; also not a code-execution vector, because the only way a command gets there
is a human typing it into this app.

**How does the command run?** A hidden subprocess needs an output viewer, a
progress model, a cancel button, and an error surface — a small terminal, badly.
Janela already has a good one.

**What happens when it fails?** `pnpm install` failing must not mean "no session".
The user needs the terminal, especially when setup broke.

## Decision

**Automation commands live in Janela's database, per project**, as
`ProjectSettings.automation`. They are edited in the app, they are never read from
the repository, and there is no file format to hand someone.

Three events, and no more:

| Event | When | Typical |
| --- | --- | --- |
| `.worktreeCreated` | After `git worktree add` and after `.worktreeinclude` copying | `pnpm install`, `make setup` |
| `.sessionStart` | The first time a session is opened | `pnpm dev`, `docker compose up` |
| `.sessionTeardown` | The user asked to delete the session | `docker compose down` |

**Each command runs in a real terminal** in the session, with
`role == .automation(event)`, in the session's directory, with the session's
resolved environment. The user watches it, scrolls it, copies from it, `Ctrl-C`s
it, and reads the actual error — no bespoke output pane, no log window, no progress
sheet.

Since [0015](0015-daemon-owned-sessions.md) that terminal lives in the daemon like
any other, which upgrades this decision from convenient to correct: `pnpm dev`
started by `.sessionStart` keeps serving after the user quits the app, and its
output is still there — scrollback intact — when they come back. An automation
mechanism that died with the window would have been a worse version of the shell
script it replaced.

Execution rules:

- **`command` is an argv array, never a shell string.** Same rule as
  `LaunchProfile`, same reason: no quoting bug class, no `sh -c`. A user who wants a
  shell writes `["zsh", "-lc", "…"]` and has chosen that explicitly.
- **Commands for one event run in order, and do not gate each other.** There is no
  dependency graph. If step two needs step one, it is one command.
- **Failure is visible and non-fatal.** A non-zero exit leaves the terminal open,
  showing the output, with the tab marked failed. The session exists and is usable.
  The only thing we never do is silently swallow it.
- **`.sessionStart` runs once per session**, not per app launch and not per client
  attach. Restarting Janela does not re-run `pnpm dev` — it is very likely still
  running — and neither does connecting from a second device. The daemon records
  that it fired; the user restarts the terminal if they want it again.
- **`.sessionTeardown` is the only blocking one**, bounded by `timeout` (default
  30 s). Past the timeout the user is asked once whether to wait or proceed.
  Deletion never hangs on a script.
- **Teardown belongs to the daemon, and it must survive the asker leaving.** A
  client can request session removal and disconnect a second later; the daemon runs
  teardown to completion regardless, and reports the outcome to whoever is attached
  when it finishes — or to nobody, which is a supported outcome. A teardown command
  abandoned halfway because a window closed would leave exactly the containers and
  databases it exists to clean up.
- **`JANELA_*` environment variables** identify the session, its directory, its
  branch and the event, so one script can serve several projects.

The commands are **not** a task runner: no scheduling, no retries, no `on:` matrix,
no templating language, no conditional execution. Three events, an argv array, and
an enable switch.

## Consequences

**Good.** Cloning a repository from a stranger cannot run anything. This is worth
more than the convenience we gave up, and it is the only property in this ADR that
cannot be added later.

**Good.** Zero UI to build for output, progress, cancellation or errors, because a
terminal already is all four. It is also consistent: everything Janela runs on your
behalf appears in a terminal you can see, which is a rule a user can learn once.

**Good.** No config file format, no parser, no schema migration, no new dependency,
and no "why is my YAML not being picked up" support surface.

**Bad.** Not shared with the team. A new colleague sets their commands up by hand,
and the project's setup steps live in two places — the README and each developer's
Janela. This is the real cost, and it is deliberate.

**Bad.** Not versioned with the branch. A repo that changes its setup step in a
commit will not update the command, and the user finds out when it fails — visibly,
in a terminal, which is the mitigation.

**Bad.** Automation terminals occupy tab space in a session the user may not care
about. Mitigated by collapsing successful automation tabs after they exit cleanly,
and keeping failed ones.

**Bad.** A user *can* still shoot themselves with `["zsh", "-lc", "$(curl …)"]`.
That is their command, typed by them, which is exactly the line this decision
draws.

## Alternatives considered

**A committed `janela.toml`.** The feature everyone asks for, and the one we would
build second. Rejected for v1 on the code-execution hazard: shipping a repo file
that runs commands is a supply-chain vector, and retrofitting a trust model onto an
existing format is much harder than adding the format later. The path back is
explicit — see *Revisit when*.

**A committed file with a trust prompt.** Workspace Trust, essentially. Rejected
because prompts that stand between a user and the thing they wanted are trained
away within a week, and because the prompt would have to re-fire on every change to
the file to be meaningful, which is either noisy or useless.

**Hidden subprocess with a custom output view.** The conventional design. Rejected:
it is a worse terminal, in an app whose entire premise is that it has a good one,
and it would need its own scrollback bound, ANSI handling and copy support.

**Devcontainer / `Makefile` conventions — just run `make setup` if it exists.**
Zero configuration, and appealing. Rejected as magic: an app that runs a `make`
target you did not ask it to run is the same hazard as the config file with worse
discoverability.

**Shell hooks (`.janela/pre-session.sh`).** Same hazard as the config file, plus
the shell-string quoting problem we removed everywhere else.

## Revisit when

- A trust model exists that we believe in — signed configs, or an explicit
  per-repository grant tied to a commit hash. Then a committed file becomes
  additive: repo commands are *proposed*, app commands are *trusted*, and the merge
  rule is written in a new ADR that supersedes this one.
- Users routinely need more than three events. The likely fourth is
  "before worktree removal", distinct from teardown; it is not speculative scope
  until someone asks.
