import { describe, expect, test } from "bun:test";

import { ACCENTS } from "./accent.ts";
import { BUILT_IN_PROFILES } from "./launch-profile.ts";
import { AUTOMATION_EVENTS } from "./project.ts";
import { isLive } from "./terminal.ts";

describe("the concept budget", () => {
  test("three automation events, and a fourth is a non-goal", () => {
    expect(AUTOMATION_EVENTS).toEqual(["worktreeCreated", "sessionStart", "sessionTeardown"]);
  });

  test("built-in profiles are argv arrays, never shell strings", () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(Array.isArray(profile.command)).toBe(true);

      for (const argument of profile.command) {
        expect(argument).not.toContain("|");
        expect(argument).not.toContain("&&");
      }
    }
  });

  test("an empty command means the login shell, and Shell is the one that has one", () => {
    const shell = BUILT_IN_PROFILES.find((profile) => profile.name === "Shell");

    expect(shell?.command).toEqual([]);
    expect(shell?.isAgent).toBe(false);
  });

  test("isAgent is presentational — every agent profile is otherwise ordinary", () => {
    for (const profile of BUILT_IN_PROFILES.filter((p) => p.isAgent)) {
      expect(profile.command.length).toBeGreaterThan(0);
      expect(profile.environment).toEqual({});
    }
  });

  test("accents include an explicit none, so absence is a value rather than a null", () => {
    expect(ACCENTS[0]).toBe("none");
  });
});

describe("isLive", () => {
  test("a terminal holding a process is live, attention or not", () => {
    expect(isLive({ kind: "running" })).toBe(true);
    expect(isLive({ kind: "needsAttention" })).toBe(true);
  });

  test("configured, exited and failed terminals hold nothing", () => {
    expect(isLive({ kind: "idle" })).toBe(false);
    expect(isLive({ kind: "exited", code: 0 })).toBe(false);
    expect(isLive({ kind: "failed", message: "no such file" })).toBe(false);
  });
});
