# Documentation

## Read in this order

If you are new — human or agent — this sequence gets you productive fastest.

1. **[`../AGENTS.md`](../AGENTS.md)** — the rules. Commands, layering, and the
   non-negotiables. Short.
2. **[`product.md`](product.md)** — what Janela is and what it refuses to be. Most
   design disagreements are settled here.
3. **[`architecture.md`](architecture.md)** — modules, seams, key flows.
4. **[`domain-model.md`](domain-model.md)** — the four nouns and the vocabulary.
5. **[`development.md`](development.md)** — setup, the loop, and what to build
   first.

Then, as needed:

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
| Add or rename a domain concept | `domain-model.md` (and justify it in `product.md`) |
| Change a technology choice | A new ADR in `decisions/` |
| Change a code style rule | `conventions.md` (and `.swift-format` / `.swiftlint.yml`) |
| Record a performance budget | `performance.md` |
| Explain a build or workflow step | `development.md` + a `make` target |

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
