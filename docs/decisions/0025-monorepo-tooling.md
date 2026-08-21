# 0025. Bun workspaces and Turborepo, with Oxc for lint and format

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** [0001](0001-project-generation.md), jointly with
  [0024](0024-tauri-client-shell.md) — 0001 also covered how the module graph is
  declared and how the fast build path works.

## Context

The previous stack had one property worth preserving above all others, and 0001
stated it plainly: **the fast path is fast enough to run on every change.** All logic
lived in one package that built in seconds without touching the app project, and
`make build` / `make test` were what a contributor — human or agent — actually ran.

The layout to reproduce: seventeen packages in a strict graph, two applications, a
native library, and a code generator. What is needed from tooling is unglamorous:
resolve dependencies, run tasks in dependency order, cache what has not changed,
lint, format, and get out of the way.

## Decision

**Bun workspaces for resolution, Turborepo for task orchestration, Oxlint and oxfmt
for lint and format.**

### Bun workspaces

Bun is already the daemon's runtime ([0020](0020-bun-daemon-runtime.md)), so using it
as the package manager means one tool rather than two. `bun install` on this
workspace takes about two seconds cold.

One property is worth naming because it shaped another decision: **Bun hoists
`node_modules`**, so an undeclared first-party import resolves anyway. That is
precisely the hole [0022](0022-layering-enforcement.md) exists to close, and it is
why the layering gate checks `package.json` against the manifest rather than trusting
resolution to fail.

`linker = "hoisted"` and `exact = true` are set deliberately: exact versions because
CI must not resolve a different tree than a contributor did, and hoisting because the
alternative is slower for no benefit we get, given the gate.

### Turborepo

The graph has real ordering constraints — the database client must be generated and
the PTY library built before anything typechecks — and re-running them on every
command would retire 0001's fast-path property immediately.

`turbo.json` declares the task graph, and the ordering is the interesting part:
`generate` and `build:native` run before `typecheck`, `test` and `build`. Caching
means a contributor who has not touched the schema does not regenerate the client.

Two things deliberately do **not** go through Turbo: `typecheck` is
`tsc --build` directly, because TypeScript's own project references already do
incremental dependency-ordered builds and layering Turbo on top adds a cache in front
of a cache; and `bun test` runs from the root, because Bun's test runner already
discovers and parallelises across the workspace.

### Oxlint and oxfmt

Both are Rust, and both are fast enough to be uninteresting — the whole workspace
lints and format-checks in well under a second, which is what keeps them in the inner
loop rather than in CI only.

**`oxfmt` is viable and is what we use.** It was evaluated properly rather than
assumed: it formats, it has a `--check` mode that exits non-zero, it is configurable
where we care (print width, quotes, trailing commas), and it sorts imports. It is
version 0.x and that is a real risk, noted below. The alternative is Prettier, which
is mature and slower; the fallback if oxfmt disappoints is a single config change.

**Markdown is excluded from formatting, deliberately.** `docs/` is hand-wrapped at 80
columns and its ADRs share a table style; a formatter rewrites both, producing an
enormous diff that obscures the actual change. This is recorded in `.oxfmtrc.json` so
nobody "fixes" it later.

Oxlint's rules carry over the conventions `.swiftlint.yml` enforced, in their
TypeScript spelling: no stray printing (the `Log` categories exist for a reason), no
non-null assertions, no `any`, and `import/no-cycle`. It also holds the coarse half
of the layering gate — see [0022](0022-layering-enforcement.md) for why that
duplication is intentional.

### Script parity

The `make` targets are gone, and each has an equivalent. The table lives in
[`../MIGRATION_MAP.md`](../MIGRATION_MAP.md) § Commands; the rule is unchanged from
0001 and worth restating here:
**everything a contributor needs to do is one command, and inventing new invocations
is how a workflow becomes tribal knowledge.**

`bun run check` is `lint` + `typecheck` + `test`, and it is exactly what CI runs. When
they diverge, the local command is the one to fix.

## Consequences

**Good.** 0001's fast-path property survives, and is faster. `bun run check` on the
skeleton completes in a couple of seconds; the old fast path was "a few seconds" for
build and test alone.

**Good.** One toolchain. Bun installs, runs, tests and bundles; Turbo orders; Oxc
lints and formats. Compared to the previous stack's Homebrew-installed XcodeGen,
swift-format and SwiftLint, this is fewer things to have installed and fewer things
to break on an upgrade.

**Good.** `project.yml`'s job is now split between `package.json` files and
`scripts/layers.ts`, and the latter is a better home for a module graph than a build
manifest ever was — it is data, it is testable, and it is the thing the gate reads.

**Bad.** Turborepo is a dependency doing something a handful of shell scripts could
do at this size, and 0001 was suspicious of exactly this kind of machinery when it
rejected Tuist for having "graph features [that] would duplicate what SPM target
dependencies already enforce". The defence is narrower than Tuist's would have been:
Turbo does ordering and caching only, and the graph enforcement lives elsewhere. If
it stops earning that, `bun --filter` is the smaller replacement.

**Bad.** oxfmt is 0.x software formatting every file in the repository. A change in
its output between versions is a repository-wide diff. It is pinned exactly, and the
mitigation is that switching to Prettier is one config change and one reformat.

**Bad.** Two lockfile-adjacent version pins that must agree: Bun's version in
`package.json` and CI, and Node's in `.node-version` and CI — the latter existing only
because Prisma's CLI needs it ([0019](0019-prisma-sql-layer.md)). Neither is checked
automatically.

**Bad.** `bun install` resolving from npm is a supply-chain surface the previous stack
had in a much smaller form: SwiftPM with four dependencies, versus a transitive npm
tree. Exact versions and a committed lockfile are the mitigation, not a solution.

## Alternatives considered

**pnpm workspaces + Turborepo.** The industry default, with strict non-hoisted
`node_modules` that would catch undeclared imports through resolution failure — a
genuine advantage over Bun here, and the one thing that gave pause. Rejected because
it means a second runtime and package manager beside Bun for no other gain, and
because [0022](0022-layering-enforcement.md) closes that hole more thoroughly than
strict resolution would: it also checks layer ordering, side crossing, and gated
external modules, none of which pnpm sees.

**Bun workspaces alone, no Turborepo.** `bun --filter` can run scripts across
packages. Tempting, and the smallest thing that could work. Rejected on ordering: the
generate-then-typecheck dependency is real, and expressing it in shell means encoding
the graph a second time. Revisit if Turbo's cost stops being worth it.

**Nx.** More capable than Turbo, with real graph analysis and generators. Rejected
for the same reason 0001 rejected Tuist: too much machinery for a project this size,
and its graph features would duplicate `scripts/layers.ts`.

**ESLint + Prettier.** Mature, universally understood, and every rule anyone could
want. Rejected on speed — they are slow enough to leave the inner loop, and a linter
that only runs in CI is a linter that stops shaping code as it is written. Oxlint
covers the rules we actually enforce. The escape hatch is that ESLint can be added
alongside if a specific rule proves necessary.

**Biome.** The closest competitor to Oxc, and a reasonable choice: similarly fast,
more mature formatter, one tool for both jobs. A close call. Oxlint was chosen for
having the larger rule set, particularly around imports, which is where this
repository's conventions live.

## Revisit when

- oxfmt's output changes across versions in a way that costs a repository-wide diff
  more than once. Prettier is the fallback.
- Turbo's cache stops paying for itself, or its configuration becomes something
  people avoid touching. `bun --filter` is the smaller replacement.
- The package count grows enough that ordering and caching need real graph analysis —
  the same trigger 0001 set for reconsidering Tuist, at roughly twenty packages.
