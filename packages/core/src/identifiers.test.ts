import { describe, expect, test } from "bun:test";

import {
  absolutePath,
  identifier,
  instant,
  newAutomationID,
  newLaunchProfileID,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  toDate,
} from "./identifiers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("identifier", () => {
  test("a UUID passes through unchanged", () => {
    const raw = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(identifier<"Session">(raw) as string).toBe(raw);
  });

  test("mixed case is accepted — a row written by another tool is still an id", () => {
    const raw = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
    expect(identifier<"Session">(raw) as string).toBe(raw);
  });

  test.each([
    ["empty", ""],
    ["a name", "claude"],
    ["no hyphens", "3f2504e04f8941d39a0c0305e82c3301"],
    ["braced", "{3f2504e0-4f89-41d3-9a0c-0305e82c3301}"],
    ["trailing text", "3f2504e0-4f89-41d3-9a0c-0305e82c3301x"],
    ["a non-hex digit", "3f2504e0-4f89-41d3-9a0c-0305e82c330g"],
  ])("%s is rejected rather than branded", (_label, raw) => {
    expect(() => identifier(raw)).toThrow(/not a UUID/);
  });

  test("every mint produces a fresh UUID", () => {
    const minted = [
      newProjectID(),
      newSessionID(),
      newTerminalID(),
      newLaunchProfileID(),
      newAutomationID(),
      newSessionID(),
    ];
    for (const value of minted) expect(value).toMatch(UUID);
    expect(new Set(minted).size).toBe(minted.length);
  });

  test("a minted id survives a re-brand, so it can be written and read back", () => {
    const minted = newSessionID();
    expect(identifier(minted)).toBe(minted);
  });
});

describe("absolutePath", () => {
  test("an absolute path passes through unnormalised", () => {
    expect(absolutePath("/Users/x/My Project/") as string).toBe("/Users/x/My Project/");
  });

  test.each([
    ["relative", "src/main.ts"],
    ["bare name", "x"],
    ["empty", ""],
    ["tilde, which no exec would expand either", "~/code"],
  ])("%s is rejected", (_label, raw) => {
    expect(() => absolutePath(raw)).toThrow(/not an absolute path/);
  });
});

describe("instant", () => {
  test("canonicalises to milliseconds and UTC", () => {
    expect(instant("2026-01-02T03:04:05Z") as string).toBe("2026-01-02T03:04:05.000Z");
  });

  test("an offset-bearing string and its UTC form are one value", () => {
    expect(instant("2026-01-02T04:04:05+01:00")).toBe(instant("2026-01-02T03:04:05Z"));
  });

  test("a Date and the string it renders as are one value", () => {
    const date = new Date("2026-01-02T03:04:05.678Z");
    expect(instant(date)).toBe(instant("2026-01-02T03:04:05.678Z"));
  });

  test.each([
    ["garbage", "garbage"],
    ["empty", ""],
    ["an invalid Date", new Date(Number.NaN)],
  ])("%s is rejected rather than becoming Invalid Date", (_label, raw) => {
    expect(() => instant(raw)).toThrow(/not an instant/);
  });

  test("toDate round-trips to the same moment", () => {
    const date = new Date("2026-01-02T03:04:05.678Z");
    expect(toDate(instant(date)).getTime()).toBe(date.getTime());
  });

  test("now is an instant in canonical form", () => {
    const before = Date.now();
    const value = now();
    expect(value).toBe(instant(value));
    expect(toDate(value).getTime()).toBeGreaterThanOrEqual(before - 1);
  });
});
