# Domain Documentation

This repository uses a **single-context** domain model.

## Structure

- **`docs/domain-model.md`** — The core domain model, the ubiquitous language (§ Vocabulary) and what is deliberately absent (§ Deliberately absent). There is no `CONTEXT.md`; this is that file.
- **`docs/product.md`** — What Janela is for, the committed v1 scope, and the non-goals. It settles "should this exist at all" questions.
- **`docs/architecture.md`** — Module boundaries, seams, the process model, and the technology choices behind them.

## Reading rules

When working on a feature or fixing a bug:

1. **Read `docs/domain-model.md` first** if you need domain orientation or to understand core terminology. Its § Vocabulary table is binding on UI copy and code names alike.
2. **Read `docs/product.md`** before adding a capability, to check the work is in scope and is not one of the listed non-goals.
3. **Read `docs/architecture.md`** before making architectural changes. It holds the module boundaries, the process model, and the reasoning behind the current technology choices.

## Updating

- **`docs/domain-model.md`** should be updated when domain concepts change, new ubiquitous language is introduced, or core architectural principles shift.
- **`docs/product.md`** should be updated when scope or a non-goal changes, so the decision is written down where it can be pointed at instead of re-argued.
- **`docs/architecture.md`** should be updated in the same change as any move of a module boundary, seam, or technology choice — record the reasoning there, not only in the pull request.
