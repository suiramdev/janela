import { describe, expect, test } from "bun:test";

import {
  parseRemovalPlan,
  serializeRemovalPlan,
  type SessionRemovalPreview,
} from "./removal-plan.ts";

const preview: SessionRemovalPreview = {
  liveTerminalCount: 3,
  canDeleteDirectory: true,
  deletesDirectory: false,
  includedPaths: [".env", "config/local.json"],
  runsTeardownAutomation: true,
  safety: {
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    hasUnpushedCommits: true,
    isLocked: false,
    hasRunningSessions: true,
  },
};

/** The plan with one field replaced by something the wire allows and we do not. */
const corrupted = (field: string, value: unknown): string =>
  JSON.stringify({ ...preview, [field]: value });

describe("the removal plan on the wire", () => {
  test("round-trips every field a confirmation names", () => {
    expect(parseRemovalPlan(serializeRemovalPlan(preview))).toEqual(preview);
  });

  test("carries only the wire fields, however wide the caller's object is", () => {
    const wider = { ...preview, repository: "/tmp/secret", extra: 1 };

    expect(JSON.parse(serializeRemovalPlan(wider))).toEqual({ ...preview });
  });

  test("text that is not JSON is not a plan", () => {
    expect(() => parseRemovalPlan("not json")).toThrow(TypeError);
    expect(() => parseRemovalPlan("[]")).toThrow(TypeError);
    expect(() => parseRemovalPlan("null")).toThrow(TypeError);
  });

  test("a missing field is refused rather than defaulted", () => {
    const { deletesDirectory: _omitted, ...withoutFlag } = preview;

    expect(() => parseRemovalPlan(JSON.stringify(withoutFlag))).toThrow(TypeError);
  });

  test("a count that arrives as a string is refused", () => {
    expect(() => parseRemovalPlan(corrupted("liveTerminalCount", "3"))).toThrow(TypeError);
    expect(() => parseRemovalPlan(corrupted("liveTerminalCount", -1))).toThrow(TypeError);
    expect(() => parseRemovalPlan(corrupted("liveTerminalCount", 1.5))).toThrow(TypeError);
  });

  test("included paths hold strings or the plan is not a plan", () => {
    expect(() => parseRemovalPlan(corrupted("includedPaths", [1]))).toThrow(TypeError);
    expect(() => parseRemovalPlan(corrupted("includedPaths", ".env"))).toThrow(TypeError);
  });

  test("a safety reason that is not a boolean is refused", () => {
    const safety = { ...preview.safety, isLocked: "no" };

    expect(() => parseRemovalPlan(corrupted("safety", safety))).toThrow(TypeError);
    expect(() => parseRemovalPlan(corrupted("safety", null))).toThrow(TypeError);
  });
});
