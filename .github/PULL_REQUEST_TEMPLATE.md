# What and why

<!-- What changes, and why it is worth changing. The diff shows what; this is for why. -->

## Checklist

- [ ] `make check` passes
- [ ] New behaviour has tests, and a bug fix has a test that failed before the fix
- [ ] Any new dependency edge points **downward** (see `AGENTS.md` § The layering rule)
- [ ] No new `try!`, force unwrap, or `print()`
- [ ] Nothing on the terminal hot path allocates per byte or per frame
- [ ] No new use of the word "workspace" — it is a project or a session
- [ ] Nothing private is logged: terminal traffic, command output, notification
      bodies, forge output, copied paths, environment values

## Decisions

- [ ] This changes an architectural decision → the reason is written down in `docs/architecture.md`
- [ ] This adds a user-visible concept → justified against `docs/product.md` § Non-goals
- [ ] This touches a documented budget → numbers below, and `docs/performance.md` updated
- [ ] This adds a file the user writes, or anything that executes on their behalf
      → an explicit answer on the trust question it raises

<!--
If you touched launch, terminal throughput, or memory, put before/after numbers
here. Performance work that is not measured does not stay fixed.
-->
