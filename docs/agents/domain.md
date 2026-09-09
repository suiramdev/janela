# Domain Documentation

This repository uses a **single-context** domain model.

## Structure

- **`docs/domain-model.md`** — The core domain model, the ubiquitous language (§ Vocabulary) and what is deliberately absent (§ Deliberately absent). There is no `CONTEXT.md`; this is that file.
- **ADRs** — Architecture Decision Records live under `docs/decisions/`.

## Reading rules

When working on a feature or fixing a bug:

1. **Read `docs/domain-model.md` first** if you need domain orientation or to understand core terminology. Its § Vocabulary table is binding on UI copy and code names alike.
2. **Search `docs/decisions/`** for relevant ADRs before making architectural changes.
3. The ADRs are numbered sequentially (e.g., `0001-some-decision.md`).

## Updating

- **`docs/domain-model.md`** should be updated when domain concepts change, new ubiquitous language is introduced, or core architectural principles shift.
- **New ADRs** should be added to `docs/decisions/` when making architectural decisions. Follow the existing numbering scheme.
