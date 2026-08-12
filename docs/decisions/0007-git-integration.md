# 0007. Shell out to `git`; do not use libgit2

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Janela needs a narrow slice of git: create a worktree, list worktrees, remove one,
determine whether removing it would lose work, and resolve which ignored files a
project's `.worktreeinclude` asks us to carry into a new worktree.

The obvious "proper" choice is to link a library — libgit2, via SwiftGit2 — and
avoid subprocess overhead. Two facts argue against it.

**libgit2's worktree support is explicitly incomplete.** Its own documentation
states that worktree support is still experimental and that *"the support for
submodules is incomplete. It is NOT recommended to make multiple checkouts of a
[repository with submodules]"*
([`../research/agents-and-git.md`](../research/agents-and-git.md) § 533,
[`../research/agents-and-git-2.md`](../research/agents-and-git-2.md) § 543). Making
multiple checkouts is the entire feature.

**The user's repository is configured for `git`, not for us.** Credential helpers,
`includeIf` conditional config, hooks, LFS filters, sparse-checkout,
`core.fsmonitor`, and signing all work because the real `git` binary runs and reads
the real config. A library reimplements a subset and diverges silently — and it
diverges in *someone's* repository, not in our tests.

The counter-argument is latency: a subprocess is a few milliseconds. That matters
only on a hot path, and ours is not hot — worktree operations are user-initiated
and already involve disk I/O.

There is one genuine exception. cmux parses git metadata in Swift rather than
shelling out, specifically for *sidebar display* metadata, because that **is** a hot
path when a sidebar refreshes ([`../research/prior-art-2.md`](../research/prior-art-2.md) § 1.1).

## Decision

All git work goes through `GitRunning`, which runs the `git` binary as a
subprocess. `WorktreeService` implements `WorktreeServing` on top of it.

Rules:

- **Arguments are always an array.** There is no shell, therefore no quoting and
  no injection.
- **Every invocation is scoped with `-C <directory>`.** We never `chdir` the
  process; multiple sessions run concurrently.
- **`GIT_OPTIONAL_LOCKS=0` on read-only commands**, so a background refresh never
  fights the user's own `git` for `index.lock`.
- **Parse porcelain formats with `-z`.** `git worktree list --porcelain -z` —
  worktree paths can contain newlines, so line-splitting is a bug.
- **Pattern matching is git's job too.** `.worktreeinclude` resolution is
  `git ls-files -o -i --exclude-from=<file> -z --directory`, not a gitignore
  matcher we wrote. Same reasoning one level down: the semantics are subtler than
  they look and a divergence surfaces in someone else's repository. See
  [0013](0013-worktreeinclude.md).
- `Foundation.Process` with `Pipe` is correct here. The fork/`login_tty` machinery
  from [0004](0004-terminal-engine.md) is only for terminals; git needs no PTY.

If sidebar refresh ever shows up in a profile, the sanctioned optimisation is to
read `.git` files directly for *display-only* metadata — never to move an
*operation* off the git binary.

## Consequences

**Good.** Correct in real repositories, including ones with submodules, LFS, or
unusual config. Behaviour matches what the user gets in their own terminal, which
makes bug reports tractable.

**Good.** The same runner serves `.worktreeinclude`, so the feature that decides
which 400 MB to copy inherits git's exact pattern semantics for free.

**Good.** Debuggable. Every operation is a command we can paste into a terminal.

**Bad.** Milliseconds per call, and we must parse text output. Mitigated by using
porcelain formats, which are explicitly stability-guaranteed.

**Bad.** Depends on a `git` on `PATH`. Every developer Mac has one, and we resolve
it rather than hardcoding `/usr/bin/git`, because the Xcode-shipped git lags and
lacks some worktree flags.

**Note.** The subprocess plumbing itself lives in `JanelaSupport` as
`ProcessRunning`, because `JanelaForge` needs the same mechanics for `gh`/`glab`
and the two are peers that may not import each other
([`../architecture.md`](../architecture.md) § Modules). `GitRunning` remains the
only git-shaped API.

## Alternatives considered

**libgit2 / SwiftGit2.** Rejected on the incomplete-worktree-support statement
above, which is disqualifying for our primary use case, plus the config-divergence
risk.

**Reimplement in Swift.** cmux does this for hot-path display metadata and it is
reasonable *for that*. Rejected as the general approach: reimplementing worktree
creation means reimplementing git's locking and index handling, which is how you
corrupt someone's repository.

## Revisit when

- Profiling shows git subprocess latency is user-visible — and then only for
  read-only display paths.
- libgit2 declares worktree support stable *and* complete for submodules.
