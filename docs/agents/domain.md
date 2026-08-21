# Domain Documentation

This repository uses a **single-context** domain model.

## Structure

- **CONTEXT.md** — Lives at the repository root. Contains the core domain model, ubiquitous language, and key architectural decisions.
- **ADRs** — Architecture Decision Records live under `docs/decisions/`.

## Reading rules

When working on a feature or fixing a bug:

1. **Read CONTEXT.md first** if you need domain orientation or to understand core terminology.
2. **Search `docs/decisions/`** for relevant ADRs before making architectural changes.
3. The ADRs are numbered sequentially (e.g., `0001-some-decision.md`).

## Updating

- **CONTEXT.md** should be updated when domain concepts change, new ubiquitous language is introduced, or core architectural principles shift.
- **New ADRs** should be added to `docs/decisions/` when making architectural decisions. Follow the existing numbering scheme.
