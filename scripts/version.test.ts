import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agreedVersion,
  readVersion,
  VERSION_PATTERN,
  VERSION_SITES,
  writeVersion,
} from "./version.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FIXTURES = {
  "apps/desktop/src-tauri/tauri.conf.json": [
    "{",
    '  "productName": "Janela",',
    '  "version": "0.0.0",',
    '  "identifier": "sh.janela.Janela",',
    '  "build": {',
    '    "version": "not-a-site"',
    "  }",
    "}",
  ].join("\n"),
  "apps/desktop/src-tauri/Cargo.toml": [
    "[package]",
    'name = "janela"',
    'version = "0.0.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'tauri = { version = "2.9", features = [] }',
  ].join("\n"),
  "apps/desktop/src-tauri/Cargo.lock": [
    "[[package]]",
    'name = "itoa"',
    'version = "1.0.18"',
    "",
    "[[package]]",
    'name = "janela"',
    'version = "0.0.0"',
    "dependencies = [",
    ' "libc",',
    "]",
  ].join("\n"),
  "apps/daemon/src/main.ts": [
    'import { log } from "@janela/support";',
    "",
    'const JANELAD_VERSION = "0.0.0";',
    "",
    "const EXIT_REFUSED_ARGUMENT = 2;",
  ].join("\n"),
} satisfies Record<string, string>;

describe("each version site", () => {
  for (const site of VERSION_SITES) {
    test(`${site.path} round-trips a stamp and changes nothing else`, () => {
      const fixture = Object.hasOwn(FIXTURES, site.path)
        ? FIXTURES[site.path as keyof typeof FIXTURES]
        : undefined;

      if (fixture === undefined) throw new Error(`no fixture for ${site.path}`);

      expect(readVersion(site, fixture)).toBe("0.0.0");

      const stamped = writeVersion(site, fixture, "1.2.3-rc.1");

      expect(readVersion(site, stamped)).toBe("1.2.3-rc.1");
      expect(stamped).toBe(fixture.replace('"0.0.0"', '"1.2.3-rc.1"'));
    });
  }

  test("writeVersion refuses text with no site", () => {
    const [site] = VERSION_SITES;

    if (site === undefined) throw new Error("no sites");

    expect(() => writeVersion(site, "nothing here", "1.0.0")).toThrow(site.path);
  });
});

describe("the repository", () => {
  test("agrees on one version across every site", () => {
    const verdict = agreedVersion(
      VERSION_SITES.map((site) => ({
        path: site.path,
        version: readVersion(site, readFileSync(join(REPO_ROOT, site.path), "utf8")),
      })),
    );

    expect(verdict.kind).toBe("agreed");
  });
});

describe("agreedVersion", () => {
  test("reports a missing site", () => {
    expect(
      agreedVersion([
        { path: "a", version: "1.0.0" },
        { path: "b", version: undefined },
      ]).kind,
    ).toBe("disagree");
  });

  test("reports two different readings", () => {
    expect(
      agreedVersion([
        { path: "a", version: "1.0.0" },
        { path: "b", version: "1.0.1" },
      ]).kind,
    ).toBe("disagree");
  });

  test("agrees when every reading matches", () => {
    expect(
      agreedVersion([
        { path: "a", version: "1.0.0" },
        { path: "b", version: "1.0.0" },
      ]),
    ).toEqual({ kind: "agreed", version: "1.0.0" });
  });
});

describe("VERSION_PATTERN", () => {
  test.each(["0.1.0", "0.2.0-rc.1"])("accepts %s", (version) => {
    expect(VERSION_PATTERN.test(version)).toBe(true);
  });

  test.each(["v0.1.0", "0.1", "0.1.0 "])("rejects %j", (version) => {
    expect(VERSION_PATTERN.test(version)).toBe(false);
  });
});
