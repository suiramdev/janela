# Steiger (FSD linter) — notes

Point-in-time research, 2026-09-16. Question: can Steiger lint Feature-Sliced
Design in `packages/ui/src`, with no `app` layer in that root (the app layer is
`apps/desktop/src`, a separate workspace package), and join `bun run lint` with a
non-zero exit on any diagnostic?

Everything below was either read out of the installed package source or run in a
throwaway fixture under `/tmp`. Nothing in this repo was modified; the only
command pointed at this repo was a read-only lint run (§7).

Probe dirs (left in place): `/tmp/steiger-probe` (source reading),
`/tmp/steiger-fx` (main fixture), `/tmp/steiger-mono` (monorepo config
placement), `/tmp/steiger-alias` (tsconfig paths), `/tmp/steiger-fix`
(`--fix`), `/tmp/steiger-misc` (stray folders, ignores/reference interaction),
`/tmp/steiger-repo` (scan of this repo).

Short version: it works, it accepts a subdirectory root, `error` is the default
severity so a bare non-zero exit already gates CI — but three things need
deciding before adoption: the config file must sit in the **cwd** of the run,
`insignificant-slice` will fire on every feature used by exactly one page, and
`--fix` writes `index.js`.

---

## 1. Versions, install, CLI

```
$ curl -s https://registry.npmjs.org/steiger | jq -r '."dist-tags"'
{ "latest": "0.6.0" }
$ curl -s https://registry.npmjs.org/@feature-sliced/steiger-plugin | jq -r '."dist-tags"'
{ "latest": "0.7.0" }
```

`steiger@0.6.0` already depends on `@feature-sliced/steiger-plugin@0.7.0`
(pinned, not a range — `node_modules/steiger/package.json`), so the plugin is
present either way; install it explicitly anyway because the config file imports
it.

```
$ bun add -d steiger @feature-sliced/steiger-plugin
installed steiger@0.6.0 with binaries:
 - steiger
installed @feature-sliced/steiger-plugin@0.7.0
78 packages installed [1424.00ms]
```

78 packages. The heavy transitives are `typescript` (used for module
resolution), `web-tree-sitter` + four `.wasm` grammars (tsx/svelte/astro/vue),
`effector`/`patronum`, `zod`, `globby`, `chokidar`, `@clack/prompts`.

Caveat: the version strings baked into `dist` are stale. `steiger --version`
prints `0.5.13` and reports the plugin as `0.6.0`, while npm says 0.6.0/0.7.0.
Do not use `--version` to assert what is installed; read `bun.lock`.

CLI surface (`bunx steiger --help`):

```
steiger [options] <path>

Options:
  -w, --watch             watch filesystem changes                     [boolean]
      --fix               apply auto-fixes                             [boolean]
      --fail-on-warnings  exit with an error code if there are warnings[boolean]
      --reporter          specify output format (pretty or json)
                        [string] [choices: "pretty", "json"] [default: "pretty"]
  -h, --help              display help message                         [boolean]
  -v, --version           Show version number                          [boolean]
```

- **Subdirectory root: yes.** `bunx steiger packages/ui/src` works; diagnostics
  are reported relative to cwd (§6).
- **Multiple roots: no.** `cli.ts` `.check()`: `if (filePaths.length > 1) throw
  new Error('Pass only one path to watch')`. Verified: `bunx steiger ./src
  ./src2` → help text, exit 1. One root per invocation; run it once per package.
- **Exit codes** (`node_modules/steiger/src/cli.ts:149-154`):

  ```ts
  if (stillRelevantDiagnostics.length > 0) {
    const onlyWarnings = stillRelevantDiagnostics.every((d) => d.severity === 'warn')
    if (consoleArgs['fail-on-warnings'] || !onlyWarnings) {
      process.exit(1)
    }
  }
  ```

  Measured, on a fixture with every rule forced to `warn`:

  ```
  warn-only EXIT=0
  warn-only --fail-on-warnings EXIT=1
  ```

  **Every rule in `fsd.configs.recommended` is `'error'`** (dumped below), so
  with the recommended config any diagnostic is already exit 1 and
  `--fail-on-warnings` is redundant. Pass it anyway so that a later `'warn'`
  override cannot silently stop failing the build.

- **Footgun: a wrong path prompts interactively.** If the root does not exist,
  the CLI does not fail cleanly — it opens a `@clack/prompts` picker
  (`chooseRootFolderFromSimilar`). With stdin closed it crashes:

  ```
  $ timeout 20 bunx steiger ./nope < /dev/null
  SystemError [ERR_TTY_INIT_FAILED]: TTY initialization failed: uv_tty_init returned EINVAL
      at chooseFromSimilar (…/steiger/dist/cli.mjs:827:32)
  EXIT=1
  ```

  Exit is 1, so CI still goes red, but the message is useless. Same happens with
  **no** path argument (`chooseRootFolderFromGuesses`). Always pass the root
  explicitly.

- Runtime depends on how it is launched, and both work. `bin` is `dist/cli.mjs`
  with a `#!/usr/bin/env node` shebang. `bunx steiger` honours the shebang and
  runs under node; `bun run <script>` that calls `steiger` runs it under bun
  itself. Measured by printing `process.execPath` from the config file, which
  cosmiconfig evaluates in the linter's own process:

  ```
  $ bun run --cwd packages/ui lint:fsd
  runtime=/Users/…/.bun/bin/bun  versions.node=26.3.0  isBun=true
  $ cd packages/ui && bunx steiger src
  runtime=/Users/…/fnm/node-versions/v24.14.0/installation/bin/node  isBun=false
  ```

  So the wired gate (`bun run check:fsd`) runs under bun, including
  cosmiconfig's TypeScript config loader, and does not need node on PATH.

Default (`pretty`) output, for reference — it prints the rule name, a doc URL,
and marks autofixable diagnostics:

```
$ bunx steiger ./src
┌ src/features/zed
✘ This slice has only one reference in slice "pages/foo". Consider merging them.
│
└ fsd/insignificant-slice: https://github.com/feature-sliced/steiger/tree/master/packages/steiger-plugin-fsd/src/insignificant-slice

┌ src/shared/ui/icons
✘ This top-level folder in shared/ui is missing a public API.
✔ Auto-fixable
```

`--reporter json` emits `{ message, location: { path }, ruleName, severity }`
objects, which is what most snippets below use.

## 2. Config file

Loaded through `cosmiconfig('steiger').search()` (`cli.ts:21`). Default async
search places for module name `steiger`
(`node_modules/cosmiconfig/dist/defaults.js:7-31`) include, in order:
`package.json`, `.steigerrc{,.json,.yaml,.yml,.js,.ts,.cjs,.mjs}`,
`.config/steigerrc*`, then `steiger.config.js`, `steiger.config.ts`,
`steiger.config.cjs`, `steiger.config.mjs`.

**`steiger.config.ts` loads under bun with no extra tooling.** cosmiconfig 9
registers a `.ts` loader by default (`defaults.js`: `'.ts': loaders_1.loadTs`)
and `typescript` is already in the dependency tree. Verified with a config
containing a TS-only annotation:

```ts
// /tmp/steiger-fx/steiger.config.ts
import { defineConfig } from 'steiger'
import fsd from '@feature-sliced/steiger-plugin'

const check: string = 'typescript-only syntax exercised'

export default defineConfig([
  ...fsd.configs.recommended,
  { ignores: ['**/*.test.*'] },
  { files: ['./src/features/**'], rules: { 'fsd/insignificant-slice': 'off' } },
  { files: ['./src/shared/**'], rules: { 'fsd/public-api': 'warn' } },
])
```

Result: loaded, `*.test.*` diagnostics disappeared, and the four `fsd/public-api`
diagnostics switched from `"severity": "error"` to `"severity": "warn"`.

### The trap: the config must be in the cwd

Steiger calls `search()` with no options, and cosmiconfig 9 defaults
`searchStrategy` to `'none'` (`cosmiconfig/dist/index.js:32`), which searches
**only the starting directory** — no upward walk. Measured from
`/tmp/steiger-mono/packages/ui` with the config at `/tmp/steiger-mono`:

```
$ node -e "…cosmiconfig('steiger',{searchStrategy:s}).search()…"
none    -> null
project -> /private/tmp/steiger-mono/steiger.config.ts
global  -> /private/tmp/steiger-mono/steiger.config.ts
```

Consequence, both directions verified by running the fixture twice: a config at
the monorepo root is only used when the command runs from the monorepo root
(`cd <root> && steiger packages/ui/src`), and a config at
`packages/ui/steiger.config.ts` is only used when the command runs from
`packages/ui` (`cd packages/ui && steiger src`). Mismatch does not error — it
silently falls back to `fsd.configs.recommended` (`cli.ts:22`), so ignores and
overrides vanish without a word.

Since `bun run lint` inside `packages/ui` (or turbo running the package's own
script) has cwd `packages/ui`, put `steiger.config.ts` in `packages/ui/`.

### Shape

`defineConfig` is identity — `export function defineConfig(config) { return
config }` (`src/app.ts:101`). It exists for types only. The array holds three
kinds of item (zod union, `src/models/config/validate-config.ts:92-131`):

1. a plugin object (`{ meta, ruleDefinitions }`) — spread in via
   `...fsd.configs.recommended`;
2. a global-ignore object: `{ ignores: string[] }` and nothing else;
3. a config object: `{ files?: string[], ignores?: string[], rules: Record<ruleName,
   'off' | 'error' | 'warn' | ['error' | 'warn', options]> }`.

Rule names are validated against the names the plugins registered
(`z.enum(allRuleNames)`), so a typo in a rule name is a hard config error. At
least one config object must be present, and options for a rule may be supplied
only once.

`fsd.configs.recommended` is exactly two items — the plugin, then one config
object with no `files` key:

```
$ node -e "import('@feature-sliced/steiger-plugin').then(m=>{const r=m.default.configs.recommended;
           console.log('length',r.length); console.log('item0 keys',Object.keys(r[0]));
           console.log('item1',JSON.stringify(r[1],null,1))})"
length 2
item0 keys [ 'meta', 'ruleDefinitions' ]
item1 {
 "rules": {
  "fsd/ambiguous-slice-names": "error",
  … all 17 enabled rules, every one "error" …
 }
}
```

Only rules that appear in the config are run at all (`$enabledRules` filters
plugin rules by "has instructions", `src/models/config/index.ts:27-33`). So
omitting the spread disables everything; the three default-disabled rules stay
off unless you name them.

### Globs

- Resolved **relative to the config file's directory**, not cwd
  (`transform-globs.ts`: `convertRelativeGlobsToAbsolute(configLocationPath, …)`,
  where `configLocationPath = dirname(filepath)`). With the config in
  `packages/ui/`, write `./src/shared/**`.
- Matching is `micromatch`; trailing slashes are stripped.
- `files` narrows a rule override; `ignores` inside a config object excludes
  files from that override; a standalone `{ ignores: [...] }` is a **global**
  ignore.
- Turning a rule off for a glob: `{ files: ['./src/shared/**'], rules: {
  'fsd/public-api': 'off' } }`. Later items win (severities are resolved by
  glob group order, `features/calculate-diagnostic-severities`).
- Global ignores are applied by **deleting files from the virtual file system**
  before rules run (`removeGlobalIgnoreFromVfs`). That has a real consequence —
  see §4b.

## 3. Rules

All 20 rules live in the `fsd/` namespace. Names read straight out of
`@feature-sliced/steiger-plugin/dist/index.js`; behaviour summarised from the
same file (line numbers cited for the non-obvious ones).

Enabled by `fsd.configs.recommended`, all at severity `error` (17):

| Rule | Meaning |
| --- | --- |
| `fsd/forbidden-imports` | No importing from a higher layer, and no cross-import between two slices of the same layer unless it goes through the target slice's `@x/<consumer>` public API. |
| `fsd/no-public-api-sidestep` | No importing another slice's internals — only its `index` or `@x` entry (special-cased for `shared/ui`, `shared/lib`; see §4f). |
| `fsd/public-api` | Every slice needs an `index`; every segment on an unsliced layer needs an `index`, except `shared/ui` and `shared/lib`, where each top-level *folder* may carry its own instead. `app` is skipped entirely. |
| `fsd/no-layer-public-api` | No `index` file directly inside a layer folder (`shared/index.ts` is a violation). `app` is the only exempt layer. |
| `fsd/insignificant-slice` | A slice on `entities`/`features`/`widgets` with zero or exactly one referencing slice. `pages` is exempt (line 587). |
| `fsd/excessive-slicing` | More than 20 ungrouped slices in `entities`/`features`/`widgets`/`pages`, or more than 20 in one slice group. |
| `fsd/segments-by-purpose` | Segment name is on a denylist of "by essence" names (`components`, `utils`, `helpers`, `types`, `hooks`, `constants`, `stores`, `services`, `modals`, `schemas`, `providers`, `fixtures`, `assets`, redux/vue/angular flavours…). Not an allowlist — see §4c. |
| `fsd/no-segmentless-slices` | A folder on a sliced layer that contains no recognised segment (`ui`/`api`/`model`/`lib`/`config`) and is not a slice group. |
| `fsd/no-segments-on-sliced-layers` | A conventional segment name used as a direct child of `entities`/`features`/`widgets`/`pages` (e.g. `features/ui/`). |
| `fsd/no-reserved-folder-names` | A folder named `ui`/`api`/`lib`/`model`/`config`/`@x` nested *inside* a segment. |
| `fsd/no-ui-in-app` | The `app` layer must not have a `ui` segment. Cannot fire in a root without `app`. |
| `fsd/no-processes` | The deprecated `processes` layer exists. |
| `fsd/ambiguous-slice-names` | A slice (or slice group) whose name equals a segment name present on the `shared` layer — e.g. `features/lib` when `shared/lib` exists. |
| `fsd/inconsistent-naming` | **`entities` layer only** (early-returns if there is no `entities` layer): sibling slice names mix singular and plural (`user` next to `products`); asks for whichever form is in the majority. `k8s`, `kubernetes`, `media` are neutral. |
| `fsd/repetitive-naming` | A word repeated in every name of a group of more than two sibling slices. |
| `fsd/shared-lib-grouping` | `shared/lib` has more than 15 direct children. |
| `fsd/typo-in-layer-name` | A top-level folder within Levenshtein distance ≤ 3 of a real layer name. See §4b — `src/lib` gets flagged as a typo of `app`. |

Disabled by default (3) — they are not in `recommended`, so they never run
unless named explicitly:

| Rule | Meaning |
| --- | --- |
| `fsd/no-cross-imports` | Same-layer cross-imports only. Subsumed by `forbidden-imports`. |
| `fsd/no-higher-level-imports` | Higher-layer imports only. Subsumed by `forbidden-imports`. |
| `fsd/import-locality` | Same-slice imports must be relative; cross-slice imports must be absolute. |

**`import-locality` must stay off in this repo.** Its check is
`if (isRelative && !isWithinSameSlice) → "Import from … should not be relative."`
(lines 1260-1272). This repo writes every import as a relative path with a `.ts`
extension, so enabling it would flag every single cross-layer import.

Rule docs live at
`https://github.com/feature-sliced/steiger/tree/master/packages/steiger-plugin-fsd/src/<rule-name>`
(the URL the reporter prints, `src/app.ts:15-20`).

## 4. Tested behaviour

Fixture (`/tmp/steiger-fx/src`), grown incrementally; all imports written as
relative paths with explicit `.ts`/`.tsx` extensions, as in this repo:

```
src/index.ts                      ← stray root file, imports ./pages/foo/index.ts
src/pages/foo/index.ts
src/pages/foo/ui/foo.ts           ← imports ../../../shared/lib/index.ts, @janela/design, ../../../features/bar/index.ts
src/pages/foo/ui/foo.test.tsx     ← deep imports (see 4a/4b)
src/pages/baz/index.ts
src/pages/baz/ui/baz.ts           ← imports ../../foo/index.ts and ../../../features/bar/model/use-bar.ts
src/features/bar/{index.ts,model/use-bar.ts,ui/widget.ts}
src/shared/lib/{index.ts,x.ts,x.test.ts,climb.ts,grouped/deep.ts}
src/shared/{index.ts,model/store.ts,ui/flat.tsx,ui/button/button.tsx,testing/harness.ts,utils/thing.ts}
src/features/ui/stray.ts
```

### a. Relative imports with `.ts` extensions — resolved correctly

No `tsconfig.json` at all, and the rules still resolve every relative
`.ts`/`.tsx` specifier:

```
$ bunx steiger ./src --reporter json | jq -r '.[] | "\(.ruleName)\t…\t\(.message)"'
fsd/forbidden-imports       src/pages/baz/ui/baz.ts    Forbidden cross-import from slice "foo".
fsd/forbidden-imports       src/shared/lib/climb.ts    Forbidden import from higher layer "pages".
fsd/no-public-api-sidestep  src/pages/baz/ui/baz.ts    Forbidden sidestep of public API when importing from "../../../features/bar/model/use-bar.ts".
```

So: `../../foo/index.ts` (same layer, other slice) → cross-import diagnostic;
`../../../features/bar/model/use-bar.ts` → sidestep diagnostic;
`../../../shared/lib/index.ts` → **no** diagnostic. Resolution is
`ts.resolveModuleName` (`@feature-sliced/filesystem/dist/index.js:148`), which
handles the `.ts` specifier without `allowImportingTsExtensions` being set
anywhere.

One important asymmetry: **`../../shared/lib/x.ts` does NOT fire.** `x.ts` is a
*file* directly in a segment, and `no-public-api-sidestep` only complains about
`shared/ui`/`shared/lib` when the import lands inside a *sub-folder* of the
segment (lines 724-737: it looks up `topLevelFolder`, and a file has none). It
does fire for a sub-folder without an index:

```
fsd/no-public-api-sidestep  src/pages/foo/ui/foo.test.tsx  … importing from "../../../shared/lib/grouped/deep.ts".
fsd/no-public-api-sidestep  src/pages/foo/ui/foo.test.tsx  … importing from "../../../shared/ui/button/button.tsx".
```

while `../../../shared/lib/x.ts` and `../../../shared/ui/flat.tsx` in the same
file stayed silent. Net: Steiger will not stop anyone deep-importing a flat file
out of `shared/lib` or `shared/ui`. It *does* enforce the public API of
`entities`/`features`/`widgets`/`pages` slices and of non-`ui`/`lib` shared
segments.

### b. Root-level files, stray folders, test files

- `src/index.ts` (outside any layer): **no diagnostic**, in any run.
  `no-layer-public-api` only inspects layer folders, and `typo-in-layer-name`
  only considers children of type folder. A root-level barrel is invisible to
  Steiger — which is what we want, since `packages/ui/package.json` exports
  `./src/index.ts`.
- Stray *folders* at the root are not invisible. Measured with
  `src/{lib,components,test,styles}`:

  ```
  fsd/typo-in-layer-name  src/lib  Layer "lib" potentially contains a typo. Did you mean "app"?
  ```

  `components`, `test` and `styles` were silent. `lib` matches because
  Levenshtein("lib","app") = 3 and the bound is 3 (inclusive). If a non-layer
  folder must live at the FSD root, expect to ignore this rule for it.
- **Test files are linted like any other file.** `pages/foo/ui/foo.test.tsx`
  produced two `no-public-api-sidestep` diagnostics. `shared/lib/x.test.ts`
  importing `./x.ts` produced none (same slice/segment — correctly allowed).
- Ignoring tests works (`{ ignores: ['**/*.test.*'] }`), but it is not free.
  Global ignores delete the files from the VFS, so they stop counting as
  references. Measured on a feature referenced only from a test:

  ```
  --- zero-config (tests counted) ---
  This slice has only one reference in slice "pages/foo". Consider merging them.
  --- with ignores **/*.test.* ---
  This slice has no references. Consider removing it.
  ```

  Recommendation: do **not** globally ignore tests. Instead scope the noisy rule,
  e.g. `{ files: ['./src/**/*.test.*'], rules: { 'fsd/no-public-api-sidestep':
  'off' } }`, if tests are allowed to reach into internals — and prefer not
  needing that at all.

### c. No `app` layer, optional `entities`, segment names

- **A root without `app` is fine.** The fixture never had an `app` layer and no
  rule complained; `getLayers` simply maps whatever layer-named folders exist.
  `no-ui-in-app` and `public-api` both early-return when `app` is absent.
  `insignificant-slice` even has a carve-out for slices referenced only from
  `app` (line 593) which we will never hit — meaning a slice used *only* by
  `apps/desktop/src` will look unreferenced from inside `packages/ui/src`
  (see §4d).
- **`entities` is optional**, as is every other layer. Only folders whose names
  are in `['shared','entities','features','widgets','pages','app']` are treated
  as layers at all (plus optional `N_`/`_` prefixes, `removePrefix`).
- `segments-by-purpose` is a **denylist**, not an allowlist
  (`BAD_NAMES_GENERIC` + react/vue/redux/angular sets, lines 963-1034). So
  `testing` is accepted by that rule:

  ```
  fsd/public-api           src/shared/testing  This segment is missing a public API.
  fsd/public-api           src/shared/utils    This segment is missing a public API.
  fsd/segments-by-purpose  src/shared/utils    This segment's name should describe the purpose of its contents, not what the contents are.
  ```

  `utils` → flagged; `testing` → not flagged by `segments-by-purpose`, only asked
  for an `index`.
- But a custom segment name does **not** make a folder a slice.
  `isSlice()` requires a child named `ui`/`api`/`model`/`lib`/`config`
  (`@feature-sliced/filesystem:139-143`), so a slice whose only segment is
  `testing/` is reported as segmentless:

  ```
  fsd/no-segmentless-slices  src/features/qux  This slice has no segments. Consider dividing the code inside into segments.
  ```

  Custom segments are therefore safe on `shared` (unsliced) but must be
  accompanied by a conventional segment inside a slice. Matching FSD's own
  advice: *"you would only create your own segments in Shared or App"*.
- `no-segments-on-sliced-layers` and `no-segmentless-slices` both fire on
  `features/ui/` — one folder, two diagnostics.

### d. `insignificant-slice`

- **`pages` is exempt** (`if (!isSliced(sourceLayerName) || sourceLayerName ===
  'pages') continue`), as are `shared` and `app`. It applies to `entities`,
  `features`, `widgets`.
- A feature referenced by exactly one page is flagged:

  ```
  fsd/insignificant-slice  src/features/bar  This slice has only one reference in slice "pages/foo". Consider merging them.
  ```

  Adding a second consumer (`pages/baz`) cleared it. Counting is by *referencing
  slice* (layer+slice key), not by file or import count — ten imports from one
  page still counts as one.
- Zero references → `This slice has no references. Consider removing it.`
- Consequence for this repo: because the FSD root stops at `packages/ui/src`,
  anything consumed only from `apps/desktop/src` counts as zero references. A
  `widgets`/`features` slice used only by the desktop app will be reported as
  dead. Either keep such code behind `pages`, or expect to turn this rule off.
  It is the single noisiest rule for our layout.

### e. tsconfig, aliases, bare package imports

- **No `tsconfig.json` is required.** Every result in §4a came from a fixture with
  no tsconfig anywhere.
- **If a tsconfig exists, its `paths` are honoured.** With
  `{"baseUrl":".","paths":{"#shared/*":["./src/shared/*"]}}`:

  ```
  fsd/no-public-api-sidestep  src/pages/foo/ui/alias.ts  … importing from "#shared/lib/grouped/deep.ts".
  ```

  Relative aliases are made absolute against the tsconfig that declares them, and
  referenced/extended configs are collected too (`collectRelatedTsConfigs`).
  Adding the tsconfig slowed the run from ~0.35 s to ~6.8 s on this fixture, so
  expect tsconfig discovery to be the dominant cost on a real project.
- **Bare package imports are ignored.** `@janela/design` never produced a
  diagnostic. Any specifier that fails to resolve, or that resolves to a file
  outside the FSD root's layer folders, is skipped (`if (resolvedDependency ===
  null) continue` / `if (dependencyLocation === undefined) continue`). Node
  builtins are dropped earlier (`dep.builtIn === true`). So cross-package imports
  to `@janela/client`, `@janela/design`, `react` etc. are invisible to Steiger —
  it cannot enforce our package-layering rule, only the intra-package FSD one.

### f. `shared` segment public APIs

From `public-api` (lines 869-907) and confirmed by the fixture:

- `shared/<segment>/index.*` is required for every segment **except** `ui` and
  `lib`.
- For `shared/ui` and `shared/lib`: either a segment-level `index`, **or** an
  `index` inside each top-level sub-folder. Measured with `shared/ui` having no
  index:

  ```
  fsd/public-api  src/shared/ui/button  This top-level folder in shared/ui is missing a public API.
  fsd/public-api  src/shared/ui/icons   This top-level folder in shared/ui is missing a public API.
  ```

  while `src/shared/ui/flat.tsx` (a bare file in the segment) was **not**
  flagged, and `src/shared/ui/card/index.tsx` satisfied the rule — so `index.tsx`
  counts, not just `index.ts`. (`isIndex` = first dot-separated part of the file
  name is `index`, any extension. Note that means `index.test.ts` would also
  count as a public API.)
- So both shapes are legal: flat `shared/ui/*.tsx` + `shared/ui/index.ts`, or
  per-component folders each with their own `index.ts`. Mixing is legal too, but
  a folder without an index is only flagged when the segment itself has no
  index. FSD documents the per-component form as the fix for bundler
  tree-shaking (§5).
- `shared/index.ts` at layer level is a violation:

  ```
  fsd/no-layer-public-api  src/shared/index.ts  Layer "shared" should not have an index file
  ```

- A sub-folder containing only non-source files (`shared/ui/icons/a.css`) is
  still flagged — the rule counts folders, not source files.

### g. `--fix` writes `.js`

```
$ bunx steiger ./src --fix ; find src -name 'index.*'
…
src/shared/model/index.js
src/shared/testing/index.js
src/shared/ui/button/index.js
src/shared/utils/index.js
```

Two rules are autofixable, and both fixes are unwelcome here. `public-api`
creates an empty file at a hardcoded `join(segment.path, 'index.js')` (lines
879-886) — `.js`, in a TypeScript-only repo. `inconsistent-naming` emits
`{ type: 'rename' }` fixes that rename slice *folders* (lines 553-567). Do not
wire `--fix` into any script.

## 5. What the FSD docs say (fsd.how/llms-full.txt, 8631 lines)

Fetched with `curl -sL https://fsd.how/llms-full.txt`. Verbatim, with section
titles:

**§ "Is it right for me?"** (line 1042):

> And that's it! There are no restrictions on what programming language, UI
> framework, or state manager you use. You can also adopt FSD incrementally, use
> it in monorepos, and scale to great lengths by breaking your app into packages
> and implementing FSD individually within them.

**§ "Worse performance of bundlers on large projects"**, item 3 (line 8319) — the
closest thing to a spec statement on our exact layout:

> If you have a very big project, there's a good chance that your application can
> be split into several big chunks. For example, Google Docs has very different
> responsibilities for the document editor and for the file browser. You can
> create a monorepo setup where each package is a separate FSD root, with its own
> set of layers. Some packages can only have the Shared and Entities layers,
> others might only have Pages and App, others still might include their own
> small Shared, but still use the big one from another package too.

That is explicit endorsement of a package with `pages/features/entities/shared`
and no `app`, and of the `app` layer living in a different package. "Each package
is a separate FSD root" also matches the CLI's one-root-per-invocation
constraint.

**§ "Layers"** (line 1130):

> Layers are standardized across all FSD projects. You don't have to use all of
> the layers, but their names are important.

and, further down the same section:

> Layers **App** and **Shared**, unlike other layers, do not have slices and are
> divided into segments directly.
>
> However, all other layers — **Entities**, **Features**, **Widgets**, and
> **Pages**, retain the structure in which you must first create slices, inside
> which you create the segments.

**§ "Segments"** (line 1164, and the reference at 8614):

> Slices, as well as layers App and Shared, consist of segments, and segments
> group your code by its purpose. Segment names are not constrained by the
> standard, but there are several conventional names for the most common
> purposes: `ui`, `api`, `model`, `lib`, `config`
>
> Usually these segments are enough for most layers, you would only create your
> own segments in Shared or App, but this is not a rule.

**§ "Public API"** (line 8130):

> A public API is a *contract* between a group of modules, like a slice, and the
> code that uses it. It also acts as a gate, only allowing access to certain
> objects, and only through that public API.

**§ "Issues with index files"** (line 8286) — the source of the plugin's
`shared/ui` + `shared/lib` carve-out:

> If your bundles grow undesirably due to a single public API in `shared/ui` or
> `shared/lib`, it's recommended to instead have a separate index file for each
> component or library

and item 2 of the same list (line 8318):

> Avoid having index files in segments on layers that have slices. For example,
> if you have an index for the feature "comments", `📄 features/comments/index.js`,
> there's no reason to have another index for the `ui` segment of that feature,
> `📄 features/comments/ui/index.js`.

**§ "No real protection against side-stepping the public API"** (line 8306):

> To catch these issues automatically, we recommend using
> [Steiger](https://github.com/feature-sliced/steiger), an architectural linter
> with a ruleset for Feature-Sliced Design.

**§ "Public API for cross-imports"** (line 8167) — the `@x` escape hatch
`forbidden-imports` recognises:

> The notation `A/@x/B` is meant to be read as "A crossed with B".
>
> Try to keep cross-imports to a minimum, and **only use this notation on the
> Entities layer**, where eliminating cross-imports is often unreasonable.

Nothing in the docs discusses running the linter per package; the monorepo
passage above is the whole story.

## 6. Monorepo placement, measured

Fixture `/tmp/steiger-mono` with the fixture tree copied to
`packages/ui/src`.

Config at monorepo root, run from monorepo root — overrides apply (the four
`public-api` diagnostics are gone because `./packages/ui/src/shared/**` turned
the rule off, and `**/*.test.*` was ignored):

```
$ cd /tmp/steiger-mono && bunx steiger packages/ui/src --reporter json
fsd/forbidden-imports            packages/ui/src/pages/baz/ui/baz.ts
fsd/forbidden-imports            packages/ui/src/shared/lib/climb.ts
fsd/no-public-api-sidestep       packages/ui/src/pages/baz/ui/baz.ts
fsd/no-segmentless-slices        packages/ui/src/features/ui
fsd/no-segments-on-sliced-layers packages/ui/src/features/ui
fsd/segments-by-purpose          packages/ui/src/shared/utils
```

Same config, run from `packages/ui` — config not found, silent fallback to
recommended (test-file and `public-api` diagnostics come back):

```
$ cd /tmp/steiger-mono/packages/ui && bunx steiger src --reporter json
… fsd/no-public-api-sidestep  packages/ui/src/pages/foo/ui/foo.test.tsx   (×2)
… fsd/public-api              packages/ui/src/shared/{model,testing,ui/button,utils}
```

Moving the config to `packages/ui/steiger.config.ts` inverts it exactly: correct
from `packages/ui`, ignored from the monorepo root. Paths in diagnostics are
printed relative to cwd either way.

Practical wiring for this repo, given cwd is the package directory:

```jsonc
// packages/ui/package.json
"scripts": { "lint": "steiger src --fail-on-warnings" }
```

with `packages/ui/steiger.config.ts` next to it and globs written as
`./src/...`.

## 7. Baseline against the real `packages/ui/src` today

Read-only run, from a probe dir so nothing was installed into the repo:

```
$ cd /tmp/steiger-repo && bunx steiger /Users/nouchetm/projects/janela/packages/ui/src --reporter json
[]
$ … ; echo "EXIT=$?"
EXIT=0
```

63 files, all flat (`app-sidebar.tsx`, `commands.ts`, `main-window.tsx`, …), no
layer-named directories. **Steiger reports nothing and exits 0.** It has no
opinion about a root that is not FSD at all — it only lints inside folders whose
names it recognises as layers. So adding Steiger before the migration is free and
silent, and it will start reporting exactly as much as has been migrated. It will
never tell us that a file is *outside* the structure.

## 8. Adoption checklist

1. `bun add -d steiger @feature-sliced/steiger-plugin` (run it in
   `packages/ui`, or at the root and rely on the hoisted binary — either way it
   changes `package.json`/`bun.lock`, which this pass did not touch).
2. `packages/ui/steiger.config.ts`, globs relative to that file.
3. `"lint": "steiger src --fail-on-warnings"` in `packages/ui/package.json`, so
   cwd matches the config's directory.
4. Decide `fsd/insignificant-slice`: it will flag every feature/entity/widget
   consumed by exactly one page, and everything consumed only from
   `apps/desktop/src`. Likeliest answer is `'off'` for this root, with the reason
   recorded in the config.
5. Keep `fsd/import-locality` off — it contradicts the repo's relative-import
   convention.
6. Never run `--fix` (it writes `index.js`).
7. Do not globally ignore `**/*.test.*` — it corrupts reference counting.
   Scope a rule override instead, if one is needed at all.
8. Expect `fsd/typo-in-layer-name` to complain if a non-layer folder named
   something like `lib` ever lands at the FSD root.
