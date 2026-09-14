import { describe, expect, test } from "bun:test";

import type { AbsolutePath } from "@janela/core";

import {
  parseBranchOverview,
  serializeBranchOverview,
  type BranchOverview,
} from "./branch-overview.ts";

const path = (raw: string): AbsolutePath => raw as AbsolutePath;

const overview: BranchOverview = {
  branches: ["main", "feat/pty", "fix/resize"],
  worktrees: [
    { directory: path("/Users/x/code/janela"), branch: "main", isMain: true },
    { directory: path("/Users/x/code/.worktrees/feat-pty"), branch: "feat/pty", isMain: false },
    // Detached: no branch at all, which is exactly the case a client must not
    // render as a branch named "undefined".
    { directory: path("/Users/x/code/.worktrees/spike"), isMain: false },
  ],
};

/** The overview with one field replaced by something the wire allows and we do not. */
const corrupted = (field: string, value: unknown): string =>
  JSON.stringify({ ...overview, [field]: value });

describe("the branch overview on the wire", () => {
  test("round-trips branches, worktrees and the detached case", () => {
    expect(parseBranchOverview(serializeBranchOverview(overview))).toEqual(overview);
  });

  test("a detached worktree carries no branch key at all", () => {
    const encoded: unknown = JSON.parse(serializeBranchOverview(overview));
    if (typeof encoded !== "object" || encoded === null || !("worktrees" in encoded)) {
      throw new Error("expected an encoded overview");
    }
    const { worktrees } = encoded;
    if (!Array.isArray(worktrees)) throw new Error("expected encoded worktrees");
    const detached: unknown = worktrees[2];
    if (typeof detached !== "object" || detached === null) {
      throw new Error("expected the detached worktree");
    }

    // `exactOptionalPropertyTypes`: an explicit `branch: undefined` is not the
    // same thing as absent, and `toEqual` would not tell the two apart.
    expect(Object.hasOwn(detached, "branch")).toBe(false);
    expect(parseBranchOverview(serializeBranchOverview(overview)).worktrees[2]).not.toHaveProperty(
      "branch",
    );
  });

  test("carries only the wire fields, however wide the caller's object is", () => {
    const wider = {
      ...overview,
      worktrees: overview.worktrees.map((entry) => ({
        ...entry,
        head: "9f2a1c4e5b6d7a8091b2c3d4e5f60718293a4b5c",
        isPrunable: false,
      })),
    };

    expect(JSON.parse(serializeBranchOverview(wider))).toEqual({ ...overview });
  });

  test("text that is not JSON is not an overview", () => {
    expect(() => parseBranchOverview("not json")).toThrow(TypeError);
    expect(() => parseBranchOverview("[]")).toThrow(TypeError);
    expect(() => parseBranchOverview("null")).toThrow(TypeError);
  });

  test("a missing field is refused rather than defaulted", () => {
    const { worktrees: _omitted, ...withoutWorktrees } = overview;

    expect(() => parseBranchOverview(JSON.stringify(withoutWorktrees))).toThrow(TypeError);
  });

  test("branches hold strings, or the overview is not an overview", () => {
    expect(() => parseBranchOverview(corrupted("branches", [1]))).toThrow(TypeError);
    expect(() => parseBranchOverview(corrupted("branches", "main"))).toThrow(TypeError);
  });

  test("a worktree without a directory or a main flag is refused", () => {
    expect(() => parseBranchOverview(corrupted("worktrees", [{ isMain: true }]))).toThrow(
      TypeError,
    );
    expect(() => parseBranchOverview(corrupted("worktrees", [{ directory: "/x" }]))).toThrow(
      TypeError,
    );
    expect(() => parseBranchOverview(corrupted("worktrees", [null]))).toThrow(TypeError);
    expect(() => parseBranchOverview(corrupted("worktrees", { directory: "/x" }))).toThrow(
      TypeError,
    );
  });

  test("a directory that is not absolute is refused, because it becomes a working directory", () => {
    expect(() =>
      parseBranchOverview(corrupted("worktrees", [{ directory: "code/x", isMain: false }])),
    ).toThrow(TypeError);
  });

  test("a branch that arrives as a number is refused, not stringified", () => {
    expect(() =>
      parseBranchOverview(corrupted("worktrees", [{ directory: "/x", branch: 7, isMain: true }])),
    ).toThrow(TypeError);
  });
});
