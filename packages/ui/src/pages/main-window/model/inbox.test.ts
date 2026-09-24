import { describe, expect, test } from "bun:test";

import { instant, type ForgeItem, type ForgeOverview, type ForgeRepository } from "@janela/core";

import {
  DEFAULT_INBOX_FILTER,
  inboxFilterOptions,
  inboxItems,
  inboxKindTitle,
  inboxStatusCounts,
  inboxStatuses,
  isFiltered,
  sessionsNeedingAttention,
  updatedAgo,
} from "./inbox.ts";
import { projectID, session, terminal, terminalID } from "./session-fixture.ts";

function item(overrides: Partial<ForgeItem> & Pick<ForgeItem, "number">): ForgeItem {
  return {
    kind: "pullRequest",
    title: `item ${overrides.number}`,
    state: "open",
    isDraft: false,
    url: `https://github.com/a/b/pull/${overrides.number}`,
    assignees: [],
    reviewers: [],
    labels: [],
    updatedAt: instant("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

function repository(
  id: string,
  items: readonly ForgeItem[],
  overrides: Partial<ForgeRepository> = {},
): ForgeRepository {
  return {
    projectID: projectID(id),
    host: "gitHub",
    name: `owner/${id}`,
    isAvailable: true,
    viewer: "me",
    items,
    ...overrides,
  };
}

const overview: ForgeOverview = {
  repositories: [
    repository("app", [
      item({ number: 1, author: "me", updatedAt: instant("2026-09-21T00:00:00Z") }),
      item({ number: 2, isDraft: true, reviewers: ["me"], labels: ["ui"] }),
      item({ number: 3, state: "merged", assignees: ["ada"] }),
      item({ number: 4, kind: "issue", assignees: ["me"], labels: ["bug"] }),
      item({ number: 5, kind: "issue", state: "closed" }),
    ]),
    repository("lab", [item({ number: 6, author: "ada" })], { host: "gitLab", viewer: "ada" }),
  ],
  sessions: [],
};

const numbers = (filter: Partial<typeof DEFAULT_INBOX_FILTER>): readonly number[] =>
  inboxItems(overview, { ...DEFAULT_INBOX_FILTER, ...filter }).map((row) => row.item.number);

describe("inboxItems", () => {
  test("the default is open pull requests, drafts included, recently updated first", () => {
    expect(numbers({})).toEqual([1, 2, 6]);
    expect(isFiltered(DEFAULT_INBOX_FILTER)).toBe(false);
  });

  test("state narrows to merged or closed, and all shows every state of the kind", () => {
    expect(numbers({ status: "merged" })).toEqual([3]);
    expect(numbers({ kind: "issue", status: "closed" })).toEqual([5]);
    expect(numbers({ status: "all" })).toHaveLength(4);
    expect(inboxStatuses("issue")).not.toContain("merged");
  });

  test("involvement is judged against each repository's own viewer", () => {
    expect(numbers({ involvement: "authored" })).toEqual([1, 6]);
    expect(numbers({ involvement: "reviewRequested" })).toEqual([2]);
    expect(numbers({ kind: "issue", involvement: "assigned" })).toEqual([4]);
  });

  test("kind, platform, repository, author, assignee and label each narrow", () => {
    expect(numbers({ kind: "issue" })).toEqual([4]);
    expect(numbers({ platform: "gitLab" })).toEqual([6]);
    expect(numbers({ repository: projectID("app") })).toEqual([1, 2]);
    expect(numbers({ author: "ada" })).toEqual([6]);
    expect(numbers({ status: "all", assignee: "ada" })).toEqual([3]);
    expect(numbers({ kind: "issue", label: "bug" })).toEqual([4]);
  });

  test("search needs every word, across title, number, branch, author, labels and repository", () => {
    expect(numbers({ query: "#6" })).toEqual([6]);
    expect(numbers({ query: "ITEM 2" })).toEqual([2]);
    expect(numbers({ query: "ui item" })).toEqual([2]);
    expect(numbers({ query: "owner/lab" })).toEqual([6]);
    expect(numbers({ query: "ui ada" })).toEqual([]);
    expect(isFiltered({ ...DEFAULT_INBOX_FILTER, query: "  " })).toBe(false);
    expect(isFiltered({ ...DEFAULT_INBOX_FILTER, query: "ui" })).toBe(true);
  });

  test("sort orders by update time or by number, both ways", () => {
    expect(numbers({ status: "all", sort: "numberHighest" })).toEqual([6, 3, 2, 1]);
    expect(numbers({ status: "all", sort: "numberLowest" })).toEqual([1, 2, 3, 6]);
    expect(numbers({ sort: "updatedOldest" }).at(-1)).toBe(1);
  });

  test("an unknown viewer matches nothing personal rather than everything", () => {
    const { viewer: _unknown, ...unnamed } = repository("app", [
      item({ number: 1, author: "me" }),
      item({ number: 2 }),
    ]);

    const anonymous: ForgeOverview = { repositories: [unnamed], sessions: [] };

    expect(
      inboxItems(anonymous, { ...DEFAULT_INBOX_FILTER, involvement: "authored" }),
    ).toHaveLength(0);
  });

  test("state counts follow every other filter and ignore the state itself", () => {
    const filter = {
      ...DEFAULT_INBOX_FILTER,
      status: "merged" as const,
      platform: "gitHub" as const,
    };

    expect(inboxStatusCounts(overview, filter)).toEqual({ open: 2, merged: 1, closed: 0, all: 3 });
  });

  test("the pull request tab speaks each forge's word", () => {
    expect(inboxKindTitle("pullRequest", ["gitHub"])).toBe("Pull requests");
    expect(inboxKindTitle("pullRequest", ["gitLab"])).toBe("Merge requests");
    expect(inboxKindTitle("pullRequest", ["gitHub", "gitLab"])).toBe("Pull & merge requests");
    expect(inboxKindTitle("issue", ["gitLab"])).toBe("Issues");
  });
});

describe("inboxFilterOptions", () => {
  test("offers every author, assignee, label and platform once, sorted", () => {
    const options = inboxFilterOptions(overview);

    expect(options.platforms).toEqual(["gitHub", "gitLab"]);
    expect(options.authors).toEqual(["ada", "me"]);
    expect(options.assignees).toEqual(["ada", "me"]);
    expect(options.labels).toEqual(["bug", "ui"]);
    expect(options.knowsViewer).toBe(true);
  });
});

describe("sessionsNeedingAttention", () => {
  test("unread, errored, and red CI on an open pull request each earn a place", () => {
    const quiet = session("quiet", { terminals: [terminal("t1")] });
    const unread = session("unread", { terminals: [terminal("t2")] });
    const red = session("red", { terminals: [terminal("t3")] });
    const mergedRed = session("merged-red", { terminals: [terminal("t4")] });
    const failing = {
      host: "gitHub" as const,
      checks: "failing" as const,
      refreshedAt: instant("2026-09-22T00:00:00Z"),
    };

    const pullRequest = {
      number: 1,
      title: "t",
      state: "open" as const,
      isDraft: false,
      url: "https://github.com/a/b/pull/1",
    };

    const rows = sessionsNeedingAttention(
      [quiet, unread, red, mergedRed],
      {
        [terminalID("t1")]: { kind: "running" },
        [terminalID("t2")]: { kind: "needsAttention" },
        [terminalID("t3")]: { kind: "running" },
        [terminalID("t4")]: { kind: "running" },
      },
      (id) =>
        id === red.id
          ? { sessionID: id, forge: { ...failing, pullRequest } }
          : id === mergedRed.id
            ? {
                sessionID: id,
                forge: { ...failing, pullRequest: { ...pullRequest, state: "merged" } },
              }
            : undefined,
    );

    expect(rows.map((row) => [row.session.name, row.reasons])).toEqual([
      ["unread", ["unread"]],
      ["red", ["checksFailing"]],
    ]);
  });
});

describe("updatedAgo", () => {
  test("picks the largest unit that fits", () => {
    const now = Date.parse("2026-09-22T12:00:00Z");

    expect(updatedAgo("2026-09-22T11:59:30Z", now)).toBe("30 seconds ago");
    expect(updatedAgo("2026-09-22T09:00:00Z", now)).toBe("3 hours ago");
    expect(updatedAgo("2026-09-21T12:00:00Z", now)).toBe("yesterday");
  });
});
