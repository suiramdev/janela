# Architecture decision records

Short documents recording a decision, the reasoning behind it, and what we gave up.

## Why bother

Because the alternative is rediscovering the argument every six months, and
because a coding agent working in this repository has no other way to learn *why*
the code looks like this. An ADR is cheaper than the discussion it replaces.

## When to write one

Write an ADR when a change would:

- add, remove, or replace a dependency — including a dependency on a binary we do
  not ship, such as `gh`
- change a module boundary or add a dependency edge
- change how processes, concurrency, or persistence work
- add, rename, or remove a domain noun
- introduce a file format the user writes, or anything that executes on their
  behalf
- contradict something in [`../product.md`](../product.md)

Do **not** write one for ordinary implementation choices. If reverting it is a
morning's work, it is not an ADR.

## How

Copy [`0000-template.md`](0000-template.md), take the next number, and open it
with the PR that implements it. ADRs are immutable once merged: to change a
decision, write a new ADR that supersedes the old one and add a `Superseded by`
line to the original. Do not edit history — the reasoning that turned out to be
wrong is the most useful part.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-project-generation.md) | Generate the Xcode project from `project.yml` | Accepted |
| [0002](0002-macos-deployment-target.md) | Target macOS 15 | Accepted |
| [0003](0003-concurrency-model.md) | Swift 6 strict concurrency, main-actor UI, off-main PTY | Accepted |
| [0004](0004-terminal-engine.md) | SwiftTerm behind a protocol; libghostty as the v2 option | Accepted |
| [0005](0005-persistence.md) | GRDB/SQLite rather than SwiftData | Accepted |
| [0006](0006-agent-activity-signals.md) | Terminal signals only; never infer agent semantics | Accepted |
| [0007](0007-git-integration.md) | Shell out to `git`; do not use libgit2 | Accepted |
| [0008](0008-sandboxing-and-distribution.md) | Unsandboxed, hardened, notarized, outside the App Store | Accepted |
| [0009](0009-projects-sessions-terminals.md) | Projects contain sessions; sessions contain terminals | Accepted |
| [0010](0010-terminal-layout.md) | Splits and tabs are a persisted layout tree, not a multiplexer | Accepted |
| [0011](0011-notifications.md) | Notification policy in the brain, delivery in the app | Accepted |
| [0012](0012-forge-integration.md) | GitHub and GitLab through the user's `gh` and `glab` | Accepted |
| [0013](0013-worktreeinclude.md) | `.worktreeinclude`: git matches the patterns, `clonefile` moves the bytes | Accepted |
| [0014](0014-project-automation.md) | Automation commands live in Janela, and run in a visible terminal | Accepted |
| [0015](0015-daemon-owned-sessions.md) | A daemon owns sessions; the app is a client | Accepted |
| [0016](0016-daemon-protocol.md) | One transport-agnostic protocol, over a Unix socket in v1 | Accepted |
| [0017](0017-daemon-lifecycle.md) | launchd owns the daemon's lifecycle, via `SMAppService` | Accepted |

Two are load-bearing enough that the rest only make sense after them:

- **[0009](0009-projects-sessions-terminals.md)** renamed the central noun.
  Everything written before it that says "workspace" means what is now a
  **session**.
- **[0015](0015-daemon-owned-sessions.md)** split the app in two. Everything written
  before it assumes one process; where that matters, the earlier ADR carries an
  **Amended** line pointing here.

### A note on amendments in place

ADRs 0004–0008 were **edited in place** when 0009 changed the domain model, and
0003–0005, 0008, 0011 and 0014 were amended again when 0015 introduced the daemon.
Both times the underlying decision held — SwiftTerm, GRDB, terminal-only signals,
shelling out to git, no sandbox — and only its context moved. Superseding six ADRs
to rename a type, or to move the same code into a different process, would have
buried the reasoning under bookkeeping.

Amended ADRs carry a dated `Amended:` line naming the ADR that forced the change,
so the history is legible without a chain of supersessions. A decision that is
actually *reversed* still gets a superseding ADR; this exception is for decisions
that survive with different surroundings, and it expires at the first tagged
release.

## Evidence

Each ADR cites [`../research/`](../research/), which holds primary-source research
gathered while making these decisions. When an ADR and the research disagree, the
research is probably newer — check the date and open an issue.
