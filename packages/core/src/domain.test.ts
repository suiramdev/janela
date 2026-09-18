import { describe, expect, test } from "bun:test";

import { ACCENTS } from "./accent.ts";
import { AUTOMATION_EVENTS } from "./project.ts";
import { isLive } from "./terminal.ts";

describe("the concept budget", () => {
  test("three automation events, and a fourth is a non-goal", () => {
    expect(AUTOMATION_EVENTS).toEqual(["worktreeCreated", "sessionStart", "sessionTeardown"]);
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
