# Architecture decision records

Short documents recording a decision, the reasoning behind it, and what we gave up.

## Why bother

Because the alternative is rediscovering the argument every six months, and
because a coding agent working in this repository has no other way to learn *why*
the code looks like this. An ADR is cheaper than the discussion it replaces.

## When to write one

Write an ADR when a change would:

- add, remove, or replace a dependency
- change a module boundary or add a dependency edge
- change how processes, concurrency, or persistence work
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

## Evidence

Each ADR cites [`../research/`](../research/), which holds primary-source research
gathered while making these decisions. When an ADR and the research disagree, the
research is probably newer — check the date and open an issue.
