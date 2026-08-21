# 0022. The module graph is data, and a script enforces it

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

AGENTS.md's first rule is that packages depend downward only, and that no client
package may import a daemon package. `../architecture.md` puts it more sharply: *an
illegal import is a build error, not a review comment.*

That sentence was true because a package manifest declared each module's
dependencies and a compiler refused anything undeclared. The migration removes both
halves of that mechanism, and replaces them with something actively worse:

1. **TypeScript has no notion of a module graph above the file level.** It will
   happily resolve any import that exists on disk.
2. **Bun hoists `node_modules`.** So `import { LiveTerminal } from "@janela/pty"`
   inside `@janela/ui` does not merely typecheck — it *resolves and runs*, with
   nothing declared anywhere.

The second point is the dangerous one. The failure is silent and it is
indistinguishable from working code, right up until the client is linking a PTY
library and the layering that made a CLI possible has quietly stopped existing.

This is not a hypothetical about a hypothetical rule. The layering is what
[0015](0015-daemon-owned-sessions.md) rests on: *"`JanelaUI` loses its dependencies
on Git, PTY, Persistence and Terminal entirely — the app cannot spawn a process any
more, even by accident, because nothing it links knows how."* Without enforcement,
"cannot" degrades to "is asked not to", and the guarantee the ADR claims stops being
a guarantee.

A rule that lives only in a review comment is a rule with a half-life.

## Decision

**The module graph lives in `scripts/layers.ts` as data, and
`scripts/check-layers.ts` enforces it as part of `bun run check` and CI.**

### The graph is data

`scripts/layers.ts` lists every package with its layer index, its side
(`shared` / `daemon` / `client` / `tool`), and its exhaustive first-party
dependencies. It is the single source of truth: `../architecture.md` describes it in
prose and `.oxlintrc.json` restates part of it, but where they disagree, the
manifest is right and the others are stale.

Layer indices, rather than a hand-drawn diagram, give two properties for free: a
dependency must have a **strictly lower** layer, so an upward edge is arithmetic
rather than judgement; and **peers share a layer**, which is how `@janela/git` and
`@janela/forge` are prevented from importing each other without a special case.

### What the gate checks

1. Every first-party import is declared in the manifest.
2. Every edge points strictly downward.
3. No edge crosses the daemon/client line. The halves meet only at `@janela/core`
   and `@janela/protocol`.
4. Each `package.json` agrees with the manifest — in **both** directions. Missing is
   what hoisting hides; extra makes the graph a lie.
5. **Gated external modules** have exactly the importers they are allowed. This is
   the successor to "only two modules may link the terminal library", generalised:
   `bun:ffi` only in `@janela/pty`, `bun:sqlite` and `@prisma/client` only in
   `@janela/db`, `node:child_process` only in `@janela/support`, `@tauri-apps/*` only
   in the desktop app, and the two terminal seams one package each. Each gate carries
   its reason and the ADR that decided it, so the failure message teaches rather than
   scolds.
6. The manifest is acyclic and every package on disk appears in it.

Type-only imports count. An architecture rule that `import type` can route around is
not an architecture rule.

### Two gates, deliberately

`.oxlintrc.json` restates the coarse side-level half as `no-restricted-imports`
overrides. That is duplication, and it is worth it: oxlint runs in the editor, so the
mistake is caught as it is typed rather than at `bun run check`. The script is the
authority and checks things a linter cannot — the arithmetic of layers, the agreement
between manifest and `package.json`, whether a package exists at all.

### The failure message is part of the design

A gate that says `error: illegal import` teaches nothing and gets worked around. Each
violation names the packages, their layers and sides, the specific reason that edge
is refused, and where to go if the edge is genuinely right:

```text
packages/ui/src/illegal.ts:1
  import/illegal-edge  @janela/ui imports @janela/terminal. @janela/ui is
  client-side and @janela/terminal is daemon-side. They meet only at @janela/core
  and @janela/protocol. Adding a dependency edge is a design change: write it down
  in docs/decisions/ first.
```

### It is not advisory

`bun run check` fails. CI fails. Changing the manifest is possible and sometimes
correct — that is the escape hatch, and it is deliberately a *visible* one, because
editing `scripts/layers.ts` is a diff a reviewer sees and an ADR can be asked for.

## Consequences

**Good.** The property `../architecture.md` claims is true again, by a different
mechanism. An illegal import fails a command rather than depending on a reviewer
noticing.

**Good.** The graph is now readable in one file, which the previous manifest was
not — it was interleaved with build settings. `scripts/layers.test.ts` asserts
properties *of the graph itself*: acyclic, halves meeting only at the shared
packages, git and forge as peers, exactly one FFI surface, one database door.

**Good.** It found a real error on its first run. The initial manifest had
`@janela/terminal-ui` and `@janela/design` at the same layer with one depending on
the other. A diagram would have hidden that; arithmetic did not.

**Bad.** It is our code, so it can have bugs, and a false negative is invisible. The
import extraction is regex-based over comment-stripped source rather than a real
parse — good enough for `import`/`export`/`require`, and it deliberately blanks
comments and template literals so that a doc comment *naming* an illegal import is
not mistaken for one, which matters because this repository's doc comments do exactly
that. A sufficiently exotic dynamic import would evade it.

**Bad.** Three places describe the graph: the manifest, the oxlint overrides, and the
prose in `../architecture.md`. They can drift. The manifest is authoritative and the
tests pin its invariants, but the oxlint overrides are hand-maintained and nothing
checks that they agree with it. Generating them from the manifest is the obvious
improvement and was not done, because a generated config file in the repository is
its own kind of confusion.

**Bad.** It is a gate a contributor meets *after* writing code, not while designing.
The compiler used to refuse at the moment of the mistake. The oxlint half narrows
that gap; it does not close it.

## Alternatives considered

**oxlint's `no-restricted-imports` alone.** Simpler, no custom code, runs in the
editor. Rejected as insufficient: it cannot check that `package.json` declares what
the manifest says — which is the specific hole Bun's hoisting opens — and expressing
a layer *ordering* in per-directory pattern lists means restating the graph N times
and maintaining it by hand. It remains as the fast half.

**`dependency-cruiser`.** Purpose-built, mature, and expresses exactly these rules.
The strongest alternative, and reasonable. Rejected on two counts: it is a
substantial dependency plus a rule language to learn for a graph of seventeen
packages, and — decisively — the rules would be in *its* configuration rather than in
a file the architecture documents can point at as the source of truth. Reconsider if
our script grows past a few hundred lines.

**TypeScript project references alone.** They are configured, and they do enforce
the *type* graph: a package cannot typecheck against another it does not reference.
Rejected as the sole mechanism because they say nothing about runtime imports, and
nothing at all about gated external modules.

**Publish packages properly and rely on real resolution.** Correct in principle and
how a published monorepo behaves. Rejected: it means a publish step in the inner
loop, for a set of packages that will never be published.

**Trust review.** What the previous stack could afford, because the compiler was
doing the work underneath. Rejected explicitly: AGENTS.md calls this rule
non-negotiable, and a non-negotiable enforced by attention is a non-negotiable with
a half-life.

## Revisit when

- The gate produces a false positive that a contributor works around by editing the
  manifest rather than the code. That is the signal the message or the model is
  wrong.
- Someone finds an import form it misses. Fix the extraction and add the case to
  `scripts/layers.test.ts`.
- The script passes a few hundred lines, at which point `dependency-cruiser` becomes
  the better trade.
- oxlint gains a way to express a layered graph directly, which would collapse the
  two gates into one.
