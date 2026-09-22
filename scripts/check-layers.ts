#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { Effect, Option, Schema } from "effect";

import { GATED_MODULES, PACKAGE_BY_NAME, PACKAGES, type PackageSpec, type Side } from "./layers.ts";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

interface FoundImport {
  readonly specifier: string;
  readonly line: number;
}

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const SIDES_MAY_DEPEND_ON = {
  shared: ["shared"],
  daemon: ["shared", "daemon"],
  client: ["shared", "client"],
  tool: ["shared", "tool"],
} as const satisfies Record<Side, readonly Side[]>;

const BUILTIN_PREFIXES = ["node:", "bun:"] as const;

const DependencyRecord = Schema.Record(Schema.String, Schema.String);

const PackageManifest = Schema.Struct({
  dependencies: Schema.optionalKey(DependencyRecord),
  devDependencies: Schema.optionalKey(DependencyRecord),
  peerDependencies: Schema.optionalKey(DependencyRecord),
});

const decodePackageManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PackageManifest));

const bold = (s: string): string => `\u001B[1m${s}\u001B[0m`;

const red = (s: string): string => `\u001B[31m${s}\u001B[0m`;

const dim = (s: string): string => s;

const violations: Violation[] = [];

const unusedEdges: string[] = [];

function fail(file: string, line: number, rule: string, message: string): void {
  violations.push({ file, line, rule, message });
}

function readTextFile(path: string): Promise<Option.Option<string>> {
  return Effect.runPromise(
    Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.map(Option.some<string>),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    ),
  );
}

function readDirectoryEntries(path: string): Promise<readonly Dirent[]> {
  return Effect.runPromise(
    Effect.tryPromise(() => readdir(path, { withFileTypes: true })).pipe(
      Effect.catch(() => Effect.succeed<readonly Dirent[]>([])),
    ),
  );
}

function readDirectoryNames(path: string): Promise<readonly string[]> {
  return Effect.runPromise(
    Effect.tryPromise(() => readdir(path)).pipe(
      Effect.catch(() => Effect.succeed<readonly string[]>([])),
    ),
  );
}

function pathExists(path: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise(() => stat(path)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );
}

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

function extractImports(source: string): readonly FoundImport[] {
  const code = stripNonCode(source);
  const found: FoundImport[] = [];
  const patterns = [
    /(?:^|\n)[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)[ \t]*import\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
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

async function sourceFiles(dir: string): Promise<readonly string[]> {
  const skip = new Set(["node_modules", "dist", "generated", "target", ".turbo", "src-tauri"]);
  const out: string[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readDirectoryEntries(current)) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;

      const full = join(current, entry.name);

      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
    }
  }

  await walk(dir);

  return out;
}

function matchesPattern(specifier: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return specifier.startsWith(pattern.slice(0, -1));

  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}

function firstPartyPackage(specifier: string): string | undefined {
  if (!specifier.startsWith("@janela/")) return undefined;

  const parts = specifier.split("/");

  return `${parts[0]}/${parts[1]}`;
}

function externalPackage(specifier: string): Option.Option<string> {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return Option.none();

  if (BUILTIN_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return Option.none();

  if (specifier === "bun") return Option.none();

  if (specifier.startsWith("@janela/")) return Option.none();

  const parts = specifier.split("/");
  const scope = parts[0];

  if (scope === undefined) return Option.none();

  if (!scope.startsWith("@")) return Option.some(scope);

  const name = parts[1];

  return name === undefined ? Option.none() : Option.some(`${scope}/${name}`);
}

async function declaredPackages(pkg: PackageSpec): Promise<Option.Option<ReadonlySet<string>>> {
  const raw = await readTextFile(join(ROOT, pkg.dir, "package.json"));

  return Option.flatMap(raw, (text) =>
    Option.map(decodePackageManifest(text), (manifest) => {
      const names = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ];

      return new Set(names);
    }),
  );
}

async function checkManifestIntegrity(): Promise<void> {
  for (const pkg of PACKAGES) {
    if (!(await pathExists(join(ROOT, pkg.dir, "package.json")))) {
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

      if (!SIDES_MAY_DEPEND_ON[pkg.side].includes(target.side)) {
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

  for (const parent of ["packages", "apps"]) {
    for (const entry of await readDirectoryNames(join(ROOT, parent))) {
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

async function checkDeclaredDependencies(pkg: PackageSpec): Promise<void> {
  const packages = await declaredPackages(pkg);

  if (Option.isNone(packages)) return;

  const declared = new Set([...packages.value].filter((d) => d.startsWith("@janela/")));
  const allowed = new Set(pkg.deps);

  for (const dep of declared) {
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

async function checkImports(pkg: PackageSpec): Promise<void> {
  const files = await sourceFiles(join(ROOT, pkg.dir));
  const allowed = new Set(pkg.deps);
  const used = new Set<string>();
  const thirdParty = await declaredPackages(pkg);

  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const source = await readTextFile(file);

    if (Option.isNone(source)) continue;

    const isTest = /\.test\.tsx?$/.test(rel) || pkg.dir === "packages/test-support";

    for (const { specifier, line } of extractImports(source.value)) {
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
              : !SIDES_MAY_DEPEND_ON[pkg.side].includes(targetSpec.side)
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

      const external = externalPackage(specifier);

      if (Option.isSome(external) && Option.isSome(thirdParty)) {
        if (!thirdParty.value.has(external.value)) {
          fail(
            rel,
            line,
            "deps/undeclared-third-party",
            `${pkg.name} imports ${specifier} but ${pkg.dir}/package.json does not declare ${external.value}. Bun's hoisting resolves it from the root anyway, which is exactly the failure this gate exists to stop — declare it at the version already in bun.lock.`,
          );
        }
      }

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

  if (!pkg.planned) {
    for (const dep of allowed) {
      if (!used.has(dep)) unusedEdges.push(`${pkg.name} → ${dep}`);
    }
  }
}

function report(): void {
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
}

await checkManifestIntegrity();

for (const pkg of PACKAGES) {
  await checkDeclaredDependencies(pkg);
  await checkImports(pkg);
}

report();
