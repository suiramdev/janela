# @janela/test-support

Temporary directories, throwaway git repositories, fakes. A devDependency
everywhere, never shipped, and not an architectural edge — `check-layers.ts`
exempts it from the declared-edge comparison for that reason.

## index.ts

`bun test` runs files in parallel, so nothing may write to a fixed path. Every
fixture is rooted in a fresh `mkdtemp` directory, resolved through `realpath`
because macOS hands out `/var/...` symlinks to `/private/var/...` and git reports
the resolved form. Both fixtures are `AsyncDisposable`: `await using` removes the
tree.

`gitFixture` gives the child a complete environment rather than merging with our
own, so a developer's global git config, credential helper, commit signing or
locale cannot change what a test sees. `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_SYSTEM` point at `/dev/null`, `GIT_TERMINAL_PROMPT` is off so a
misconfigured remote fails instead of hanging, and `LANG=C` keeps git's porcelain
output in the one language the parsers were written against. `HOME` is inside
the fixture for the same reason.

Git behaviour is tested against real repositories, never a mock — a mock would
only prove our assumptions. See `docs/testing.md`.
