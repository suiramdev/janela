import { describe, expect, test } from "bun:test";

import type { LaunchProfileID } from "./identifiers.ts";
import { newLaunchProfileID } from "./identifiers.ts";
import type { LaunchProfile, LaunchProfileAvailability } from "./launch-profile.ts";
import {
  availableProfiles,
  BUILT_IN_PROFILES,
  isProfileAvailable,
  needsPathLookup,
  profileAvailability,
  usesLoginShell,
} from "./launch-profile.ts";

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: newLaunchProfileID(),
    name: "Claude Code",
    iconName: "sparkles",
    command: ["claude"],
    environment: {},
    isAgent: true,
    isBuiltIn: false,
    ...overrides,
  };
}

function reported(entries: readonly [LaunchProfileID, boolean][]): LaunchProfileAvailability {
  return Object.fromEntries(entries);
}

describe("the built-in profiles", () => {
  test("carry no id, because ids are minted at seed time", () => {
    for (const built of BUILT_IN_PROFILES) {
      expect(Object.keys(built)).not.toContain("id");
    }
  });

  test("have unique names, which is the identity seeding matches on", () => {
    const names = BUILT_IN_PROFILES.map((built) => built.name);

    expect(new Set(names).size).toBe(names.length);
  });

  test("offer exactly one login shell, so a picker is never empty", () => {
    const shells = BUILT_IN_PROFILES.filter((built) => usesLoginShell(built));

    expect(shells.map((built) => built.name)).toEqual(["Shell"]);
  });

  test("are all marked built-in, which is what protects them from deletion", () => {
    expect(BUILT_IN_PROFILES.every((built) => built.isBuiltIn)).toBe(true);
  });
});

describe("needsPathLookup", () => {
  test("a bare name is looked up; anything with a separator is used as written", () => {
    expect(needsPathLookup("claude")).toBe(true);
    expect(needsPathLookup("/opt/homebrew/bin/claude")).toBe(false);
    expect(needsPathLookup("./claude")).toBe(false);
    expect(needsPathLookup("bin/claude")).toBe(false);
  });
});

describe("profileAvailability", () => {
  test("asks the predicate only about names that need looking up", () => {
    const asked: string[] = [];
    const shell = profile({ name: "Shell", command: [] });
    const absolute = profile({ command: ["/opt/homebrew/bin/claude"] });
    const bare = profile({ command: ["codex", "--model", "o3"] });

    const availability = profileAvailability([shell, absolute, bare], (executable) => {
      asked.push(executable);

      return true;
    });

    expect(asked).toEqual(["codex"]);
    expect(availability[shell.id]).toBe(true);
    expect(availability[absolute.id]).toBe(true);
    expect(availability[bare.id]).toBe(true);
  });

  test("records a missing binary as false rather than omitting it", () => {
    const missing = profile({ command: ["opencode"] });
    const availability = profileAvailability([missing], () => false);

    expect(Object.keys(availability)).toEqual([missing.id]);
    expect(availability[missing.id]).toBe(false);
  });

  test("only argv[0] decides; later arguments are never probed", () => {
    const asked: string[] = [];

    profileAvailability([profile({ command: ["zsh", "-lc", "claude"] })], (executable) => {
      asked.push(executable);

      return true;
    });

    expect(asked).toEqual(["zsh"]);
  });
});

describe("isProfileAvailable", () => {
  test("a login shell is available with nothing reported at all", () => {
    expect(isProfileAvailable(profile({ command: [] }), reported([]))).toBe(true);
  });

  test("a path-bearing command is available with nothing reported at all", () => {
    const absolute = profile({ command: ["/usr/local/bin/aider"] });

    expect(isProfileAvailable(absolute, reported([]))).toBe(true);
  });

  test("a bare name nobody has reported on is hidden, not assumed available", () => {
    expect(isProfileAvailable(profile(), reported([]))).toBe(false);
  });

  test("a bare name reported false is hidden", () => {
    const missing = profile();

    expect(isProfileAvailable(missing, reported([[missing.id, false]]))).toBe(false);
  });

  test("a bare name reported true is available", () => {
    const present = profile();

    expect(isProfileAvailable(present, reported([[present.id, true]]))).toBe(true);
  });

  test("another profile's report does not make this one available", () => {
    const wanted = profile();
    const other = profile();

    expect(isProfileAvailable(wanted, reported([[other.id, true]]))).toBe(false);
  });
});

describe("availableProfiles", () => {
  test("keeps the order it was given and drops only the unavailable", () => {
    const shell = profile({ name: "Shell", command: [] });
    const claude = profile({ name: "Claude Code" });
    const codex = profile({ name: "Codex", command: ["codex"] });
    const opencode = profile({ name: "OpenCode", command: ["opencode"] });

    const visible = availableProfiles(
      [claude, shell, opencode, codex],
      reported([
        [claude.id, true],
        [codex.id, true],
        [opencode.id, false],
      ]),
    );

    expect(visible.map((entry) => entry.name)).toEqual(["Claude Code", "Shell", "Codex"]);
  });

  test("an empty availability record still yields the login shell", () => {
    const shell = profile({ name: "Shell", command: [] });

    expect(availableProfiles([profile(), shell], reported([])).map((e) => e.name)).toEqual([
      "Shell",
    ]);
  });

  test("round-trips with profileAvailability over a fake PATH", () => {
    const installed = new Set(["claude"]);
    const shell = profile({ name: "Shell", command: [] });
    const claude = profile({ name: "Claude Code" });
    const codex = profile({ name: "Codex", command: ["codex"] });
    const all = [shell, claude, codex];

    const visible = availableProfiles(
      all,
      profileAvailability(all, (executable) => installed.has(executable)),
    );

    expect(visible.map((entry) => entry.name)).toEqual(["Shell", "Claude Code"]);
  });
});
