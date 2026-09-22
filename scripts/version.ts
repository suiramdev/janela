#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

export interface VersionSite {
  readonly path: string;
  readonly pattern: RegExp;
}

export type VersionReading = {
  readonly path: string;
  readonly version: string | undefined;
};

export type VersionVerdict =
  | { readonly kind: "agreed"; readonly version: string }
  | { readonly kind: "disagree"; readonly readings: readonly VersionReading[] };

export const VERSION_SITES: readonly VersionSite[] = [
  {
    path: "apps/desktop/src-tauri/tauri.conf.json",
    pattern: /^(  "version": ")([^"]+)(",)$/m,
  },
  {
    path: "apps/desktop/src-tauri/Cargo.toml",
    pattern: /^(version = ")([^"]+)(")$/m,
  },
  {
    path: "apps/desktop/src-tauri/Cargo.lock",
    pattern: /(\[\[package\]\]\nname = "janela"\nversion = ")([^"]+)(")/,
  },
  {
    path: "apps/daemon/src/main.ts",
    pattern: /(const JANELAD_VERSION = ")([^"]+)(";)/,
  },
];

export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const ROOT = new URL("../", import.meta.url).pathname;

const USAGE = [
  "usage: bun run version            print the version every site agrees on",
  "       bun run version <version>  stamp MAJOR.MINOR.PATCH[-pre] into every site",
].join("\n");

const EXIT_DISAGREE = 1;

const EXIT_REFUSED_ARGUMENT = 2;

export function readVersion(site: VersionSite, text: string): string | undefined {
  return site.pattern.exec(text)?.[2];
}

export function writeVersion(site: VersionSite, text: string, version: string): string {
  if (!site.pattern.test(text)) {
    throw new Error(`${site.path}: no version site matched ${site.pattern}`);
  }

  return text.replace(site.pattern, `$1${version}$3`);
}

export function agreedVersion(readings: readonly VersionReading[]): VersionVerdict {
  const first = readings[0]?.version;

  if (first !== undefined && readings.every((reading) => reading.version === first)) {
    return { kind: "agreed", version: first };
  }

  return { kind: "disagree", readings };
}

function readSites(): readonly VersionReading[] {
  return VERSION_SITES.map((site) => ({
    path: site.path,
    version: readVersion(site, readFileSync(`${ROOT}${site.path}`, "utf8")),
  }));
}

function printDisagreement(readings: readonly VersionReading[]): void {
  for (const reading of readings) {
    console.error(`${reading.path}: ${reading.version ?? "missing"}`);
  }
}

function stamp(version: string): void {
  const verdict = agreedVersion(readSites());
  const previous = verdict.kind === "agreed" ? verdict.version : "mixed";

  for (const site of VERSION_SITES) {
    const path = `${ROOT}${site.path}`;

    writeFileSync(path, writeVersion(site, readFileSync(path, "utf8"), version));
  }

  console.log(`${previous} → ${version} in ${VERSION_SITES.length} files`);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const verdict = agreedVersion(readSites());

    if (verdict.kind === "agreed") {
      console.log(verdict.version);

      return;
    }

    printDisagreement(verdict.readings);
    process.exit(EXIT_DISAGREE);
  }

  const [version] = args;

  if (args.length !== 1 || version === undefined) {
    console.error(USAGE);
    process.exit(EXIT_REFUSED_ARGUMENT);
  }

  if (!VERSION_PATTERN.test(version)) {
    console.error(`version: "${version}" is not MAJOR.MINOR.PATCH[-pre]`);
    process.exit(EXIT_REFUSED_ARGUMENT);
  }

  stamp(version);
}

if (import.meta.main) main();
