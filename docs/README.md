# Documentation

## Read in this order

If you are new — human or agent — this sequence gets you productive fastest.

1. **[`../AGENTS.md`](../AGENTS.md)** — the rules. Commands, layering, and the
   non-negotiables. Short.
2. **[`product.md`](product.md)** — what Janela is and what it refuses to be. Most
   design disagreements are settled here.
3. **[`architecture.md`](architecture.md)** — two processes, modules, seams, key
   flows.
4. **[`domain-model.md`](domain-model.md)** — the four nouns (project, session,
   terminal, launch profile) and the vocabulary.
5. **[`development.md`](development.md)** — setup, the loop, and what to build
   first.

Then, as needed:

- **[`MIGRATION_MAP.md`](MIGRATION_MAP.md)** — where everything went when the stack
  changed. Read this if you know the previous codebase, or if a document you are
  reading mentions Swift.
- **[`conventions.md`](conventions.md)** — how the code is written.
- **[`testing.md`](testing.md)** — what we test and what we refuse to fake.
- **[`performance.md`](performance.md)** — budgets and how to measure them.
- **[`decisions/`](decisions/)** — ADRs. Read the relevant one before changing a
  decision.
- **[`research/`](research/)** — primary-source research behind the ADRs.

## What goes where

| If you want to… | Write it in |
| --- | --- |
| Change what the product is | `product.md` |
| Change a module boundary or dependency | `architecture.md` + an ADR |
| Add or rename a domain concept | `domain-model.md` + an ADR (and justify it in `product.md`) |
| Change a technology choice | A new ADR in `decisions/` |
| Add a file the user writes, or anything that runs on their behalf | An ADR first — see `0013` and `0014` for why the two were answered differently |
| Change the wire protocol, or what a client may do | `decisions/0016-daemon-protocol.md` + a version bump |
| Change a code style rule | `conventions.md` (and `.swift-format` / `.swiftlint.yml`) |
| Record a performance budget | `performance.md` |
| Explain a build or workflow step | `development.md` + a `make` target |

## If you have read an older version of these documents

Two things changed underneath everything else.

**The central noun.** What was a **workspace** is now a **session**; what was a
**session** is now a **terminal**; **repository** was absorbed into **project**, a
new grouping level.
[`decisions/0009-projects-sessions-terminals.md`](decisions/0009-projects-sessions-terminals.md)
records why.

**The process model.** Janela was one process; it is now a daemon plus clients.
Anything that says "single process", "no IPC", or "sessions die when the app quits"
predates [`decisions/0015-daemon-owned-sessions.md`](decisions/0015-daemon-owned-sessions.md)
and is wrong.

Both times, earlier ADRs were amended in place rather than superseded, because the
decisions held and only their surroundings moved. See
[`decisions/README.md`](decisions/README.md) for that exception and its expiry.

## Principles for these documents

- **Explain why, not what.** The code says what. If a document only restates a
  signature, delete it.
- **Be specific enough to be wrong.** "Fast" is unreviewable; "250 ms cold launch"
  can be measured and can fail.
- **Write down what we rejected.** A decision without its alternatives gets
  relitigated every six months.
- **Keep it near the code where possible.** A doc comment beats a wiki page. These
  files exist for what does not fit in one.
- **Stale documentation is worse than none.** If you change behaviour these
  describe, change them in the same PR.
