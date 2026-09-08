import { describe, expect, test } from "bun:test";

import { GATED_MODULES, PACKAGES, type PackageSpec } from "./layers.ts";

/**
 * Tests for the graph itself.
 *
 * `check-layers.ts` verifies that the *code* obeys the manifest. These verify that
 * the manifest still describes the architecture docs/architecture.md claims — the
 * properties that would make the gate pass while the design was wrong.
 */
const byName = new Map(PACKAGES.map((p) => [p.name, p]));

describe("the module graph", () => {
  test("every edge points strictly downward", () => {
    for (const pkg of PACKAGES) {
      for (const dep of pkg.deps) {
        const target = byName.get(dep);
        expect(target, `${dep} is not in the manifest`).toBeDefined();
        expect(target!.layer, `${pkg.name} → ${dep}`).toBeLessThan(pkg.layer);
      }
    }
  });

  test("the two halves meet only at @janela/core and @janela/protocol", () => {
    const meetingPoints = new Set(["@janela/core", "@janela/protocol", "@janela/support"]);
    for (const pkg of PACKAGES.filter((p) => p.side === "client" || p.side === "daemon")) {
      for (const dep of pkg.deps) {
        const target = byName.get(dep)!;
        if (target.side === pkg.side) continue;
        expect(
          meetingPoints.has(dep),
          `${pkg.name} (${pkg.side}) reaches ${dep} (${target.side})`,
        ).toBe(true);
      }
    }
  });

  test("no client package depends on a daemon package, or the reverse", () => {
    const opposite = { client: "daemon", daemon: "client" } as const;
    for (const pkg of PACKAGES) {
      if (pkg.side !== "client" && pkg.side !== "daemon") continue;
      for (const dep of pkg.deps) {
        expect(byName.get(dep)!.side).not.toBe(opposite[pkg.side]);
      }
    }
  });

  test("the graph is acyclic", () => {
    const seen = new Set<string>();
    const walk = (name: string, stack: readonly string[]): void => {
      expect(stack.includes(name), `cycle: ${[...stack, name].join(" → ")}`).toBe(false);
      if (seen.has(name)) return;
      seen.add(name);
      for (const dep of byName.get(name)?.deps ?? []) walk(dep, [...stack, name]);
    };
    for (const pkg of PACKAGES) walk(pkg.name, []);
  });

  test("git and forge are peers, so neither can depend on the other", () => {
    const git = byName.get("@janela/git")!;
    const forge = byName.get("@janela/forge")!;
    expect(git.layer).toBe(forge.layer);
    expect(git.deps).not.toContain("@janela/forge");
    expect(forge.deps).not.toContain("@janela/git");
  });

  test("the shared layer imports from neither side", () => {
    for (const pkg of PACKAGES.filter((p) => p.side === "shared")) {
      for (const dep of pkg.deps) {
        expect(byName.get(dep)!.side).toBe("shared");
      }
    }
  });

  test("test-support depends on nothing, so every layer can use it", () => {
    expect(byName.get("@janela/test-support")!.deps).toEqual([]);
  });
});

describe("gated modules", () => {
  test("two terminal seams, and exactly one package each", () => {
    const headless = GATED_MODULES.find((g) => g.pattern === "@xterm/headless");
    const renderer = GATED_MODULES.find((g) => g.pattern === "@xterm/xterm");
    expect(headless?.allowed).toEqual(["@janela/terminal"]);
    expect(renderer?.allowed).toEqual(["@janela/terminal-ui"]);
  });

  test("exactly one FFI surface, and it is the PTY", () => {
    expect(GATED_MODULES.find((g) => g.pattern === "bun:ffi")?.allowed).toEqual(["@janela/pty"]);
  });

  test("the database has exactly one door", () => {
    for (const pattern of ["bun:sqlite", "@prisma/client", "@prisma/driver-adapter-utils"]) {
      expect(GATED_MODULES.find((g) => g.pattern === pattern)?.allowed).toEqual(["@janela/db"]);
    }
  });

  test("every gate names its reason, with the ADR that decided it", () => {
    for (const gate of GATED_MODULES) {
      expect(gate.reason.length, gate.pattern).toBeGreaterThan(40);
      expect(gate.allowed.length, gate.pattern).toBeGreaterThan(0);
    }
  });

  test("every allowed package exists", () => {
    for (const gate of GATED_MODULES) {
      for (const name of gate.allowed) {
        expect(byName.has(name), `${gate.pattern} allows unknown ${name}`).toBe(true);
      }
    }
  });
});

describe("the manifest is complete", () => {
  test("every package has a unique name and directory", () => {
    expect(new Set(PACKAGES.map((p) => p.name)).size).toBe(PACKAGES.length);
    expect(new Set(PACKAGES.map((p) => p.dir)).size).toBe(PACKAGES.length);
  });

  test("the full package set, so one cannot quietly disappear", () => {
    // docs/MIGRATION_MAP.md is the table this was derived from; this is the count,
    // so a package going missing fails a test rather than a review.
    const expected: readonly string[] = [
      "@janela/support",
      "@janela/core",
      "@janela/protocol",
      "@janela/git",
      "@janela/pty",
      "@janela/db",
      "@janela/forge",
      "@janela/terminal",
      "@janela/session",
      "@janela/daemon",
      "@janela/janelad",
      "@janela/client",
      "@janela/design",
      "@janela/terminal-ui",
      "@janela/ui",
      "@janela/desktop",
      "@janela/test-support",
    ];
    expect([...byName.keys()].toSorted()).toEqual([...expected].toSorted());
  });

  test("only @janela/forge is planned", () => {
    expect(PACKAGES.filter((p: PackageSpec) => p.planned === true).map((p) => p.name)).toEqual([
      "@janela/forge",
    ]);
  });
});
