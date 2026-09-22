import { describe, expect, test } from "bun:test";

import type { AbsolutePath } from "@janela/core";
import { Schema } from "effect";

import {
  parseBranchOverview,
  serializeBranchOverview,
  type BranchOverview,
} from "./branch-overview.ts";

type WireValue =
  | string
  | number
  | boolean
  | null
  | readonly WireValue[]
  | { readonly [key: string]: WireValue };

const path = (raw: string): AbsolutePath => raw as AbsolutePath;

const overview: BranchOverview = {
  branches: ["main", "feat/pty", "fix/resize"],
  worktrees: [
    { directory: path("/Users/x/code/janela"), branch: "main", isMain: true },
    { directory: path("/Users/x/code/.worktrees/feat-pty"), branch: "feat/pty", isMain: false },
    { directory: path("/Users/x/code/.worktrees/spike"), isMain: false },
  ],
};

const EncodedOverview = Schema.fromJsonString(
  Schema.Struct({
    branches: Schema.Array(Schema.String),
    worktrees: Schema.Array(
      Schema.Struct({
        directory: Schema.String,
        branch: Schema.optionalKey(Schema.String),
        isMain: Schema.Boolean,
      }),
    ),
  }),
);

const decodeEncodedOverview = Schema.decodeUnknownSync(EncodedOverview);

const corrupted = (field: string, value: WireValue): string =>
  JSON.stringify({ ...overview, [field]: value });

describe("the branch overview on the wire", () => {
  test("round-trips branches, worktrees and the detached case", () => {
    expect(parseBranchOverview(serializeBranchOverview(overview))).toEqual(overview);
  });

  test("a detached worktree carries no branch key at all", () => {
    const encoded = decodeEncodedOverview(serializeBranchOverview(overview));
    const detached = encoded.worktrees[2];

    expect(detached).toBeDefined();
    expect(detached).not.toHaveProperty("branch");
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
