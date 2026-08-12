# What and why

<!-- What changes, and why it is worth changing. The diff shows what; this is for why. -->

## Checklist

- [ ] `make check` passes
- [ ] New behaviour has tests, and a bug fix has a test that failed before the fix
- [ ] Any new dependency edge points **downward** (see `AGENTS.md` § The layering rule)
- [ ] No new `try!`, force unwrap, or `print()`
- [ ] Nothing on the terminal hot path allocates per byte or per frame

## Decisions

- [ ] This changes an architectural decision → ADR added or superseded in `docs/decisions/`
- [ ] This adds a user-visible concept → justified against `docs/product.md` § Non-goals
- [ ] This touches a documented budget → numbers below, and `docs/performance.md` updated

<!--
If you touched launch, terminal throughput, or memory, put before/after numbers
here. Performance work that is not measured does not stay fixed.
-->
