import { describe, expect, test } from "bun:test";

import { fuzzyScore, rankBy } from "./fuzzy-match.ts";

const byName = (left: string, right: string): number => left.localeCompare(right);

describe("fuzzyScore", () => {
  test("a subsequence matches and anything else does not", () => {
    expect(fuzzyScore("jpt", "janela fix/pty")).toBeDefined();
    expect(fuzzyScore("zz", "janela fix/pty")).toBeUndefined();
    expect(fuzzyScore("ptyfix", "fix/pty")).toBeUndefined();
  });

  test("a word start beats the same letters mid-word", () => {
    const atStart = fuzzyScore("ma", "main");
    const inside = fuzzyScore("ma", "remain");

    expect(atStart).toBeDefined();
    expect(inside).toBeDefined();
    expect(atStart ?? 0).toBeGreaterThan(inside ?? 0);
  });

  test("case is ignored and an empty query matches everything equally", () => {
    expect(fuzzyScore("PTY", "fix/pty")).toBeDefined();
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });
});

describe("rankBy", () => {
  test("drops non-matches and ranks a word-start match first", () => {
    const items = ["remain", "main", "unrelated"];

    expect(rankBy("ma", items, (item) => item, byName)).toEqual(["main", "remain"]);
  });

  test("an empty query keeps everything, in the tie-break's order", () => {
    const items = ["c", "a", "b"];

    expect(rankBy("", items, (item) => item, byName)).toEqual(["a", "b", "c"]);
  });
});
