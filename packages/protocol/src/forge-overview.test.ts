import { describe, expect, test } from "bun:test";

import { instant, newProjectID, newSessionID, type ForgeOverview } from "@janela/core";

import { parseForgeOverview, serializeForgeOverview } from "./forge-overview.ts";

const overview: ForgeOverview = {
  repositories: [
    {
      projectID: newProjectID(),
      host: "gitHub",
      name: "suiramdev/janela",
      isAvailable: true,
      viewer: "suiramdev",
      items: [
        {
          kind: "pullRequest",
          number: 42,
          title: "feat: the inbox",
          state: "open",
          isDraft: false,
          url: "https://github.com/suiramdev/janela/pull/42",
          author: "suiramdev",
          assignees: [],
          reviewers: ["octo"],
          labels: ["ui"],
          branch: "feat/inbox",
          updatedAt: instant("2026-09-22T15:02:00Z"),
        },
      ],
    },
    { projectID: newProjectID(), host: "gitLab", name: "b", isAvailable: false, items: [] },
  ],
  sessions: [
    {
      sessionID: newSessionID(),
      branch: "feat/inbox",
      forge: {
        host: "gitHub",
        pullRequest: {
          number: 42,
          title: "feat: the inbox",
          state: "open",
          isDraft: false,
          url: "https://github.com/suiramdev/janela/pull/42",
        },
        checks: "failing",
        refreshedAt: instant("2026-09-22T15:03:00Z"),
      },
    },
    { sessionID: newSessionID() },
  ],
};

describe("forge overview", () => {
  test("round-trips, absent optionals staying absent", () => {
    const parsed = parseForgeOverview(serializeForgeOverview(overview));

    expect(parsed).toEqual(overview);
    expect(Object.hasOwn(parsed.sessions[1] ?? {}, "branch")).toBe(false);
  });

  test("a link that is not a web address is refused, so no client is handed one to open", () => {
    const text = serializeForgeOverview(overview).replaceAll(
      "https://github.com/suiramdev/janela/pull/42",
      "file:///Applications/Calculator.app",
    );

    expect(() => parseForgeOverview(text)).toThrow(TypeError);
  });

  test("a session id that is not a UUID is refused", () => {
    expect(() =>
      parseForgeOverview(JSON.stringify({ repositories: [], sessions: [{ sessionID: "x" }] })),
    ).toThrow(TypeError);
  });
});
