import { describe, expect, test } from "bun:test";

import { instant, type ForgeState, type SessionForgeLink } from "@janela/core";

import { sessionID } from "./session-fixture.ts";
import { sessionRowDetails } from "./session-forge.ts";

const forge = {
  host: "gitLab",
  pullRequest: {
    number: 7,
    title: "the inbox",
    state: "open",
    isDraft: true,
    url: "https://gitlab.com/a/b/-/merge_requests/7",
  },
  checks: "running",
  refreshedAt: instant("2026-09-22T00:00:00Z"),
} as const satisfies ForgeState;

const link: SessionForgeLink = { sessionID: sessionID("s"), branch: "feat/inbox", forge };

describe("sessionRowDetails", () => {
  test("a pull request stands in for the branch, with its state, checks and link", () => {
    expect(sessionRowDetails(link)).toEqual({
      kind: "pullRequest",
      reference: "!7",
      status: "draft",
      checks: "running",
      link: {
        url: "https://gitlab.com/a/b/-/merge_requests/7",
        label: "Open merge request !7 on GitLab",
      },
    });
  });

  test("a branch with no pull request is the branch, and nothing to open", () => {
    const bare: SessionForgeLink = { sessionID: sessionID("s"), branch: "main" };

    expect(sessionRowDetails(bare)).toEqual({ kind: "branch", branch: "main" });
  });

  test("nothing known draws nothing", () => {
    expect(sessionRowDetails(undefined)).toBeUndefined();
    expect(sessionRowDetails({ sessionID: sessionID("s") })).toBeUndefined();
  });

  test("a rollup of none is not drawn as a result", () => {
    const quiet: SessionForgeLink = { ...link, forge: { ...forge, checks: "none" } };

    expect(sessionRowDetails(quiet)).toMatchObject({ kind: "pullRequest", checks: undefined });
  });
});
