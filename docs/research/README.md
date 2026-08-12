# Research

Primary-source research gathered while making the decisions in
[`../decisions/`](../decisions/).

## What these are

Verbatim research artifacts. Every non-obvious claim cites the repository file,
official document, or specification that owns it — not a blog post about it. They
are the evidence an ADR points at when it says "because".

They were produced by independent research passes, which is why some topics have
two files (`-2` suffix). The passes were run separately and cite different
sources; where they overlap they corroborate each other, and where they differ
that is itself useful signal. Both are kept rather than merged, so the provenance
of each claim stays intact.

## Contents

| File | Covers |
| --- | --- |
| [`prior-art.md`](prior-art.md), [`prior-art-2.md`](prior-art-2.md) | Teardown of Orca, Superset and cmux: stacks, domain models, worktree handling, agent supervision, persistence |
| [`terminal-stack.md`](terminal-stack.md), [`terminal-stack-2.md`](terminal-stack-2.md) | SwiftTerm vs libghostty vs writing our own; macOS PTY APIs; the `DispatchIO` read path |
| [`apple-platform.md`](apple-platform.md), [`apple-platform-2.md`](apple-platform-2.md) | SwiftUI vs AppKit; Swift 6 concurrency; SwiftData vs GRDB; project generation; distribution; CI |
| [`agents-and-git.md`](agents-and-git.md), [`agents-and-git-2.md`](agents-and-git-2.md) | Claude Code / Codex / OpenCode invocation and hooks; OSC 9/133/777; git worktree mechanics; libgit2 limitations |

## Findings that changed the design

Worth calling out, because these corrected assumptions rather than confirming them:

1. **`posix_spawn` cannot give a child a controlling terminal.** Neither can
   `Foundation.Process`. The only correct shape is `openpty()` + `fork()` +
   `login_tty()` + `execve()`, with async-signal-safe code only between fork and
   exec. This invalidated the original spawn design; see `PseudoTerminal.swift`.
2. **Back-pressure must stop reading, not drop bytes.** A VT stream is stateful,
   so dropping bytes desynchronises the parser. Water marks that stop re-arming
   the read are the correct mechanism; see `ByteStream.swift`.
3. **SwiftTerm compiles in Swift 5 language mode**, so it needs `@preconcurrency`
   containment from our Swift 6 modules. See
   [ADR 0003](../decisions/0003-concurrency-model.md).
4. **libghostty is more viable than assumed** — it ships an official Swift
   XCFramework example, and cmux uses it in production. It is a real v2 option
   rather than a theoretical one. See [ADR 0004](../decisions/0004-terminal-engine.md).
5. **libgit2's worktree support is documented as incomplete** for submodules,
   which is disqualifying for our main use case. See
   [ADR 0007](../decisions/0007-git-integration.md).
6. **cmux is workspace-centric, not worktree-centric** — worktrees are not a
   top-level noun there either. Independent corroboration of the product thesis.

## Using these

- They are **point-in-time**. Check the claims before relying on them for
  something load-bearing; upstream projects move.
- They are **not authoritative for this project** — the ADRs are. If research and
  an ADR disagree, the ADR is the decision and the research is the evidence it was
  weighed against.
- They are **not maintained**. Do not update them to match new reality; run new
  research and add a new file.
