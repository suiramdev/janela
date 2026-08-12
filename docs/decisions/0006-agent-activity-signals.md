# 0006. Terminal signals only; never infer agent semantics

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

The most valuable thing this app can tell you is *"this one needs you"*. A user
with six sessions, each holding two or three terminals, wants the badge to be
right.

There are two ways to produce it.

**Infer it.** Watch the PTY stream and guess from what the agent printed — spinner
frames, prompt strings, known phrases. This is what "understands your agent" would
mean.

It is also a trap. The output is a byte stream of ANSI-styled TUI redraws, not a
protocol. Every agent has a different UI, each of them redesigns it, and the
inference silently breaks. Worse, it breaks *quietly*: a badge that is wrong 10%
of the time is worse than no badge, because the user stops trusting it.

**Let the terminal tell you.** There are real, specified mechanisms for this, and
the ecosystem has converged on them:

- **BEL** (`\a`) — the oldest attention signal there is.
- **OSC 9** and **OSC 777** — desktop notifications from a terminal program.
- **OSC 133** semantic prompt marks (`A` prompt start, `C` command start,
  `D;<code>` command finished) — shell integration that makes "notify me when this
  long command finishes" exact rather than heuristic.

cmux, the closest prior art, does exactly this: it parses OSC 9/99/777 out of the
stream, and additionally ships a `cmux notify` CLI plus hook integrations so the
agent *pushes* its status rather than being scraped
([`../research/prior-art-2.md`](../research/prior-art-2.md) § 1.3). Their sidebar
state is agent-pushed via `cmux set-status`/`set-progress` — described in our
research as "a much cheaper design than screen-scraping agent output".

Claude Code, Codex and OpenCode all support hooks that can run an arbitrary
command on lifecycle events ([`../research/agents-and-git.md`](../research/agents-and-git.md)),
which is the supported way to get an exact signal.

## Decision

Janela derives terminal status **only** from terminal-level signals:

- BEL, OSC 9, OSC 777 → `TerminalEventSink.terminalDidRequestAttention`
- OSC 133 marks → `TerminalEventSink.terminalDidMarkPrompt`
- OSC 0/2 → title; OSC 7 → working directory
- process exit → `TerminalState.exited(code:)`

`TerminalState` therefore has no `.waitingForUser` or `.agentThinking` case, and
adding one requires superseding this ADR.

Signals are per **terminal**, and a session's status is derived from its terminals
rather than stored. This is why splits are modelled as data rather than delegated
to a multiplexer: one `tmux` process is one terminal to us, which would collapse
"the agent in the left pane finished" into "something in there beeped". See
[0010](0010-terminal-layout.md).

What happens *after* a signal — badge only, or badge plus a Notification Centre
delivery — is policy, and it lives in a separate decision:
[0011](0011-notifications.md). This ADR is only about what we are willing to treat
as a signal in the first place.

Where an agent supports hooks, we **document** how to point them at Janela rather
than parsing harder. A `janela notify` CLI is the natural v2 of this, mirroring
cmux's approach.

## Consequences

**Good.** Works identically for `claude`, `codex`, `opencode`, `make`, `pytest`,
and a tool released next year that we have never heard of. Nothing to keep up to
date. No per-agent code.

**Good.** Cheap. Detecting an escape sequence in a stream we are already parsing
costs nothing; heuristics would cost a scan per frame.

**Bad.** Fidelity depends on the user's setup. OSC 133 requires shell integration
that many users do not have, so "command finished" is unavailable for them. We
treat its absence as normal and never gate a feature on it — the fallback is BEL
and process exit, which always work.

**Bad.** We cannot show "agent is thinking" or a token count. That is the trade,
and [`../product.md`](../product.md) § 2 makes it deliberately.

**Bad.** A user running `tmux` inside a terminal gets one badge for whatever is
inside it. Correct, and unavoidable without parsing — it is also why we ship splits
ourselves.

## Alternatives considered

**Parse agent output.** Rejected above. The failure mode is silent and erodes
trust in the one signal the app exists to provide.

**Per-agent adapters.** A protocol per supported agent — Claude Code's stream-json
mode, for instance. Rejected for v1: it makes Janela an agent runtime, contradicts
[`../product.md`](../product.md) § Non-goals, and creates a maintenance
relationship with every vendor's release cycle. It would also mean agents run
*differently* inside Janela than outside it, which is precisely what we promised
not to do.

**Poll process state.** `waitpid` / process-group inspection tells us alive or
dead, which we already get, and nothing about wanting attention.

## Revisit when

- A `janela notify` CLI plus documented hook recipes are worth shipping — this is
  the expected next step and does *not* supersede this ADR, it extends it.
- The agents converge on a common machine-readable status channel that does not
  require us to interpret a TUI.
