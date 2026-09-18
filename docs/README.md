# Documentation

## Read in this order

If you are new — human or agent — this sequence gets you productive fastest.

1. **[`../AGENTS.md`](../AGENTS.md)** — the rules. Commands, layering, and the
   non-negotiables. Short.
2. **[`product.md`](product.md)** — what Janela is and what it refuses to be. Most
   design disagreements are settled here.
3. **[`architecture.md`](architecture.md)** — two processes, modules, seams, key
   flows.
4. **[`domain-model.md`](domain-model.md)** — the three nouns (project, session,
   terminal) and the vocabulary.
5. **[`development.md`](development.md)** — setup, the loop, and what to build
   first.

Then, as needed:

- **[`MIGRATION_MAP.md`](MIGRATION_MAP.md)** — where everything went when the stack
  changed. Read this if you know the previous codebase, or if a document you are
  reading mentions Swift.
- **[`conventions.md`](conventions.md)** — how the code is written.
- **[`testing.md`](testing.md)** — what we test and what we refuse to fake.
- **[`performance.md`](performance.md)** — budgets and how to measure them.
- **[`survival-proof.md`](survival-proof.md)** — the procedure that exercises the
  central bet (quit the app, the terminals live), its per-step verdict, and the
  defects that run found. Re-run it when the daemon's lifecycle, the handshake or
  the frame loop changes.
- **[`packages/`](packages/)** — one page per package: the decisions behind its
  modules, the constraints they were measured against, and what was deliberately
  left out. Read the page for a package before changing it.
- **[`scripts.md`](scripts.md)** — the workspace tooling: `bun run desktop`, the daemon
  helpers, the survival probe, and the gates that keep the build honest.
- **[`research/`](research/)** — primary-source research behind the architecture and
  the technology choices.

## What goes where

| If you want to… | Write it in |
| --- | --- |
| Change what the product is | `product.md` |
| Change a module boundary or dependency | `architecture.md` |
| Add or rename a domain concept | `domain-model.md` (and justify it in `product.md`) |
| Change a technology choice | `architecture.md` |
| Add a file the user writes, or anything that runs on their behalf | `architecture.md` — answer the trust question first: are we reading what the user wrote, or running what the repository supplied? |
| Change the wire protocol, or what a client may do | `architecture.md` + a version bump |
| Move a file inside `@janela/ui`, or change its layers and segments | `architecture.md` § Inside `@janela/ui` — and `bun run check:fsd` must agree |
| Change a code style rule | `conventions.md` (and `.swift-format` / `.swiftlint.yml`) |
| Record a performance budget | `performance.md` |
| Prove the daemon really owns the terminals, or record that it does not | `survival-proof.md` |
| Explain a build or workflow step | `development.md` + a `make` target |

## If you have read an older version of these documents

Two things changed underneath everything else.

**The central noun.** What was a **workspace** is now a **session**; what was a
**session** is now a **terminal**; **repository** was absorbed into **project**, a
new grouping level. [`domain-model.md`](domain-model.md) has the vocabulary as it
now stands.

**The process model.** Janela was one process; it is now a daemon plus clients.
Anything that says "single process", "no IPC", or "sessions die when the app quits"
predates that change and is wrong.

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
