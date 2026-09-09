#!/usr/bin/env bun
/**
 * The layering gate.
 *
 * AGENTS.md's first rule is that packages depend downward only, and that no client
 * package may import a daemon package. That rule used to be enforced by a compiler,
 * because an undeclared dependency simply did not resolve. Two things changed:
 *
 *   1. TypeScript has no notion of a module graph above the file level.
 *   2. Bun hoists `node_modules`, so `import "@janela/pty"` from `@janela/ui`
 *      resolves *and runs* even though nothing declared it.
 *
 * Together those turn a build error into a review comment, and a rule that is
 * only a review comment is a rule that erodes. So this script re-creates what the
 * compiler used to do, and `bun run check` fails when it is violated.
 *
 * It checks six things:
 *
 *   1. Every first-party import is declared in `scripts/layers.ts`.
 *   2. Every dependency edge points strictly downward by layer.
 *   3. No edge crosses the daemon/client line. The two halves meet only at
 *      `@janela/core` and `@janela/protocol`.
 *   4. Each package's `package.json` dependencies agree with the manifest —
 *      neither undeclared (which hoisting hides) nor declared-but-unused (which
 *      makes the graph a lie).
 *   5. Gated external modules are imported only where they are allowed — the
 *      successor to "only two modules may link the terminal library".
 *   6. The manifest itself is acyclic and every package on disk appears in it.
 *
 * Run: `bun run check:layers`
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { GATED_MODULES, PACKAGE_BY_NAME, PACKAGES, type PackageSpec } from "./layers.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const violations: Violation[] = [];

function fail(file: string, line: number, rule: string, message: string): void {
  violations.push({ file, line, rule, message });
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Blank out comments and template literals so a doc comment that *names* an
 * illegal import — and this repository's doc comments do exactly that — is not
 * mistaken for one. Replacing with same-length spaces keeps line numbers honest.
 */
/** Same-length blanking, so line numbers survive. */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (source[i] === "`") {
      let j = i + 1;
      while (j < n && !(source[j] === "`" && source[j - 1] !== "\\")) j++;
      out += blank(source.slice(i, Math.min(j + 1, n)));
      i = j + 1;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

/**
 * Every module specifier this file depends on, with its line number.
 *
 * Type-only imports count. An architecture rule that `import type` can route
 * around is not an architecture rule.
 */
function extractImports(source: string): Array<{ specifier: string; line: number }> {
  const code = stripNonCode(source);
  const found: Array<{ specifier: string; line: number }> = [];
  const patterns = [
    // import … from "x" / import "x" / export … from "x"
    /^[ \t]*(?:import|export)\b[^;\n]*?["']([^"']+)["']/gm,
    // dynamic import("x")
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    // require("x")
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      const specifier = m[1];
      if (specifier === undefined) continue;
      const line = code.slice(0, m.index).split("\n").length;
      found.push({ specifier, line });
    }
  }
  return found;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const skip = new Set(["node_modules", "dist", "generated", "target", ".turbo", "src-tauri"]);
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function matchesPattern(specifier: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return specifier.startsWith(pattern.slice(0, -1));
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

/** The first-party package a specifier names, if any. `@janela/x/sub` → `@janela/x`. */
function firstPartyPackage(specifier: string): string | undefined {
  if (!specifier.startsWith("@janela/")) return undefined;
  const parts = specifier.split("/");
  return `${parts[0]}/${parts[1]}`;
}

const SIDES_MAY_DEPEND_ON: Record<string, readonly string[]> = {
  shared: ["shared"],
  daemon: ["shared", "daemon"],
  client: ["shared", "client"],
  tool: ["shared", "tool"],
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** 6. The manifest describes reality, and describes something acyclic. */
async function checkManifestIntegrity(): Promise<void> {
  for (const pkg of PACKAGES) {
    try {
      await stat(join(ROOT, pkg.dir, "package.json"));
    } catch {
      fail(
        "scripts/layers.ts",
        0,
        "manifest/missing-package",
        `${pkg.name} is in the manifest but ${pkg.dir}/package.json does not exist.`,
      );
    }
    for (const dep of pkg.deps) {
      const target = PACKAGE_BY_NAME.get(dep);
      if (!target) {
        fail(
          "scripts/layers.ts",
          0,
          "manifest/unknown-dep",
          `${pkg.name} declares a dependency on ${dep}, which is not in the manifest.`,
        );
        continue;
      }
      if (target.layer >= pkg.layer) {
        fail(
          "scripts/layers.ts",
          0,
          "manifest/not-downward",
          `${pkg.name} (layer ${pkg.layer}) declares ${dep} (layer ${target.layer}). ` +
            `Dependencies point downward only. If you need an upward reference, you need an interface in the lower package instead.`,
        );
      }
      if (!SIDES_MAY_DEPEND_ON[pkg.side]?.includes(target.side)) {
        fail(
          "scripts/layers.ts",
          0,
          "manifest/crosses-sides",
          `${pkg.name} (${pkg.side}) declares ${dep} (${target.side}). ` +
            `The daemon and client halves meet only at @janela/core and @janela/protocol.`,
        );
      }
    }
  }

  // Every workspace directory must be accounted for. A package nobody declared
  // is a package outside the graph, which is how the graph stops being true.
  for (const parent of ["packages", "apps"]) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(ROOT, parent));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = `${parent}/${entry}`;
      if (!PACKAGES.some((p) => p.dir === dir)) {
        fail(
          "scripts/layers.ts",
          0,
          "manifest/unlisted-package",
          `${dir} exists but is not in scripts/layers.ts. Add it to the graph, with its layer and side.`,
        );
      }
    }
  }
}

/** 4. package.json agrees with the manifest, in both directions. */
async function checkDeclaredDependencies(pkg: PackageSpec): Promise<void> {
  const manifestPath = join(ROOT, pkg.dir, "package.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return;
  }
  const json = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = new Set(
    [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})].filter(
      (d) => d.startsWith("@janela/"),
    ),
  );
  const allowed = new Set(pkg.deps);

  for (const dep of declared) {
    // test-support is a devDependency everywhere and is not an architectural edge.
    if (dep === "@janela/test-support") continue;
    if (!allowed.has(dep)) {
      fail(
        `${pkg.dir}/package.json`,
        0,
        "deps/undeclared-in-manifest",
        `${pkg.name} depends on ${dep} in package.json but not in scripts/layers.ts. Decide which is right — the manifest is the architecture.`,
      );
    }
  }
  for (const dep of allowed) {
    if (!declared.has(dep)) {
      fail(
        `${pkg.dir}/package.json`,
        0,
        "deps/missing-in-package-json",
        `${pkg.name} may depend on ${dep} per the manifest, but package.json does not list it. Bun's hoisting would let it resolve anyway, which is exactly the failure this gate exists to stop.`,
      );
    }
  }
}

/** 1, 2, 3, 5. What the sources actually import. */
async function checkImports(pkg: PackageSpec): Promise<void> {
  const files = await sourceFiles(join(ROOT, pkg.dir));
  const allowed = new Set(pkg.deps);
  const used = new Set<string>();

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const source = await readFile(file, "utf8");
    const isTest = /\.test\.tsx?$/.test(rel) || pkg.dir === "packages/test-support";

    for (const { specifier, line } of extractImports(source)) {
      // --- first-party edges
      const target = firstPartyPackage(specifier);
      if (target !== undefined && target !== pkg.name) {
        used.add(target);
        const targetSpec = PACKAGE_BY_NAME.get(target);
        if (!targetSpec) {
          fail(
            rel,
            line,
            "import/unknown-package",
            `imports ${specifier}, which is not a package in scripts/layers.ts.`,
          );
          continue;
        }
        if (isTest && targetSpec.name === "@janela/test-support") continue;
        if (!allowed.has(target)) {
          const why =
            targetSpec.layer >= pkg.layer
              ? `${target} is at layer ${targetSpec.layer} and ${pkg.name} is at layer ${pkg.layer} — that edge points sideways or upward.`
              : !SIDES_MAY_DEPEND_ON[pkg.side]?.includes(targetSpec.side)
                ? `${pkg.name} is ${pkg.side}-side and ${target} is ${targetSpec.side}-side. They meet only at @janela/core and @janela/protocol.`
                : `${target} is not in ${pkg.name}'s declared dependencies.`;
          fail(
            rel,
            line,
            "import/illegal-edge",
            `${pkg.name} imports ${specifier}. ${why} Adding a dependency edge is a design change: write it down in docs/architecture.md first.`,
          );
        }
      }

      // --- gated external modules
      for (const gate of GATED_MODULES) {
        if (!matchesPattern(specifier, gate.pattern)) continue;
        if (gate.allowed.includes(pkg.name)) continue;
        fail(
          rel,
          line,
          "import/gated-module",
          `${pkg.name} imports ${specifier}, which only ${gate.allowed.join(", ")} may import. ${gate.reason}`,
        );
      }
    }
  }

  // A declared edge nobody uses makes the graph less true, not more safe. Only
  // reported for implemented packages: a skeleton legitimately declares the
  // edges its seams will need.
  if (!pkg.planned) {
    for (const dep of allowed) {
      if (!used.has(dep)) unusedEdges.push(`${pkg.name} → ${dep}`);
    }
  }
}

const unusedEdges: string[] = [];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

await checkManifestIntegrity();
for (const pkg of PACKAGES) {
  await checkDeclaredDependencies(pkg);
  await checkImports(pkg);
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `[2m${s}[0m`;

if (violations.length > 0) {
  console.error(`\n${red(bold(`Layering violations (${violations.length}):`))}\n`);
  for (const v of violations) {
    const where = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    console.error(`  ${bold(where)}`);
    console.error(`    ${red(v.rule)}  ${v.message}\n`);
  }
  console.error(
    dim(
      "The module graph lives in scripts/layers.ts and is described in\n" +
        "docs/architecture.md § Packages. If the edge you want is genuinely right,\n" +
        "change the manifest and say why in docs/architecture.md — that is a design\n" +
        "change, which is the point of this gate.\n",
    ),
  );
  process.exit(1);
}

const counts = PACKAGES.reduce<Record<string, number>>((acc, p) => {
  acc[p.side] = (acc[p.side] ?? 0) + 1;
  return acc;
}, {});
const edges = PACKAGES.reduce((n, p) => n + p.deps.length, 0);

console.log(
  `layers ok — ${PACKAGES.length} packages (${Object.entries(counts)
    .map(([side, n]) => `${n} ${side}`)
    .join(", ")}), ${edges} edges, ${GATED_MODULES.length} gated modules`,
);
if (unusedEdges.length > 0) {
  console.log(
    dim(
      `  note: ${unusedEdges.length} declared edges not yet imported (expected while the packages are skeletons):`,
    ),
  );
  for (const e of unusedEdges) console.log(dim(`    ${e}`));
}
