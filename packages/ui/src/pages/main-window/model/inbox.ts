import type {
  Forge,
  ForgeItem,
  ForgeItemKind,
  ForgeOverview,
  ForgeRepository,
  ProjectID,
  Session,
  SessionForgeLink,
  SessionID,
  TerminalID,
  TerminalState,
} from "@janela/core";

import { sessionStatus } from "./session-rows.ts";

export type InboxKind = ForgeItemKind;

export type InboxStatus = "open" | "merged" | "closed" | "all";

export type InboxSort = "updatedNewest" | "updatedOldest" | "numberHighest" | "numberLowest";

export type InboxInvolvement = "any" | "assigned" | "authored" | "reviewRequested";

export type AttentionReason = "unread" | "error" | "checksFailing";

export interface InboxFilter {
  readonly kind: InboxKind;
  readonly status: InboxStatus;
  readonly query: string;
  readonly sort: InboxSort;
  readonly platform: Forge | undefined;
  readonly repository: ProjectID | undefined;
  readonly involvement: InboxInvolvement;
  readonly author: string | undefined;
  readonly assignee: string | undefined;
  readonly label: string | undefined;
}

export interface InboxItemRow {
  readonly key: string;
  readonly item: ForgeItem;
  readonly repository: ForgeRepository;
}

export interface InboxFilterOptions {
  readonly platforms: readonly Forge[];
  readonly repositories: readonly ForgeRepository[];
  readonly authors: readonly string[];
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly knowsViewer: boolean;
}

export interface InboxSessionRow {
  readonly session: Session;
  readonly reasons: readonly AttentionReason[];
  readonly link: SessionForgeLink | undefined;
}

interface RelativeStep {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly seconds: number;
}

export const DEFAULT_INBOX_FILTER: InboxFilter = {
  kind: "pullRequest",
  status: "open",
  query: "",
  sort: "updatedNewest",
  platform: undefined,
  repository: undefined,
  involvement: "any",
  author: undefined,
  assignee: undefined,
  label: undefined,
};

export const INBOX_STATUS_TITLE = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  all: "All",
} as const satisfies Record<InboxStatus, string>;

export const INBOX_SORT_TITLE = {
  updatedNewest: "Recently updated",
  updatedOldest: "Least recently updated",
  numberHighest: "Newest",
  numberLowest: "Oldest",
} as const satisfies Record<InboxSort, string>;

export const INBOX_INVOLVEMENT_TITLE = {
  any: "Anyone's",
  assigned: "Assigned to me",
  authored: "Opened by me",
  reviewRequested: "Review requested",
} as const satisfies Record<InboxInvolvement, string>;

export const ATTENTION_REASON_TITLE = {
  unread: "waiting for you",
  error: "stopped with an error",
  checksFailing: "checks failed",
} as const satisfies Record<AttentionReason, string>;

export const INBOX_KINDS: readonly InboxKind[] = ["pullRequest", "issue"];

export const INBOX_STATUSES: readonly InboxStatus[] = ["open", "merged", "closed", "all"];

export const INBOX_SORTS: readonly InboxSort[] = [
  "updatedNewest",
  "updatedOldest",
  "numberHighest",
  "numberLowest",
];

export const INBOX_INVOLVEMENTS: readonly InboxInvolvement[] = [
  "any",
  "assigned",
  "authored",
  "reviewRequested",
];

const SECONDS: RelativeStep = { unit: "second", seconds: 1 };

const RELATIVE_SCALE: readonly RelativeStep[] = [
  { unit: "year", seconds: 31_536_000 },
  { unit: "month", seconds: 2_592_000 },
  { unit: "week", seconds: 604_800 },
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
];

const SORT_ORDER = {
  updatedNewest: (left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt),
  updatedOldest: (left, right) => left.item.updatedAt.localeCompare(right.item.updatedAt),
  numberHighest: (left, right) => right.item.number - left.item.number,
  numberLowest: (left, right) => left.item.number - right.item.number,
} as const satisfies Record<InboxSort, (left: InboxItemRow, right: InboxItemRow) => number>;

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const ABSOLUTE_TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function isInvolved(
  item: ForgeItem,
  viewer: string | undefined,
  involvement: InboxInvolvement,
): boolean {
  if (involvement === "any") return true;

  if (viewer === undefined) return false;

  if (involvement === "assigned") return item.assignees.includes(viewer);

  if (involvement === "authored") return item.author === viewer;

  return item.reviewers.includes(viewer);
}

export function inboxKindTitle(kind: InboxKind, platforms: readonly Forge[]): string {
  if (kind === "issue") return "Issues";

  if (platforms.length === 1 && platforms[0] === "gitLab") return "Merge requests";

  return platforms.includes("gitLab") ? "Pull & merge requests" : "Pull requests";
}

export function matchesStatus(item: ForgeItem, status: InboxStatus): boolean {
  return status === "all" || item.state === status;
}

export function inboxStatuses(kind: InboxKind): readonly InboxStatus[] {
  return kind === "issue" ? INBOX_STATUSES.filter((status) => status !== "merged") : INBOX_STATUSES;
}

export function matchesQuery(item: ForgeItem, repository: ForgeRepository, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== "");

  if (terms.length === 0) return true;

  const haystack = [
    item.title,
    `#${item.number}`,
    `!${item.number}`,
    item.branch ?? "",
    item.author ?? "",
    repository.name,
    ...item.labels,
    ...item.assignees,
  ]
    .join("\n")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

export function inboxItems(overview: ForgeOverview, filter: InboxFilter): readonly InboxItemRow[] {
  return matchingItems(overview, filter)
    .filter((row) => matchesStatus(row.item, filter.status))
    .toSorted(SORT_ORDER[filter.sort]);
}

export function inboxStatusCounts(
  overview: ForgeOverview,
  filter: InboxFilter,
): Readonly<Record<InboxStatus, number>> {
  const counts = { open: 0, merged: 0, closed: 0, all: 0 };

  for (const row of matchingItems(overview, filter)) {
    counts[row.item.state] += 1;
    counts.all += 1;
  }

  return counts;
}

function matchingItems(overview: ForgeOverview, filter: InboxFilter): readonly InboxItemRow[] {
  const rows: InboxItemRow[] = [];

  for (const repository of overview.repositories) {
    if (filter.platform !== undefined && repository.host !== filter.platform) continue;

    if (filter.repository !== undefined && repository.projectID !== filter.repository) continue;

    for (const item of repository.items) {
      if (item.kind !== filter.kind) continue;

      if (!matchesQuery(item, repository, filter.query)) continue;

      if (!isInvolved(item, repository.viewer, filter.involvement)) continue;

      if (filter.author !== undefined && item.author !== filter.author) continue;

      if (filter.assignee !== undefined && !item.assignees.includes(filter.assignee)) continue;

      if (filter.label !== undefined && !item.labels.includes(filter.label)) continue;

      rows.push({ key: `${repository.projectID}:${item.kind}:${item.number}`, item, repository });
    }
  }

  return rows;
}

export function inboxFilterOptions(overview: ForgeOverview): InboxFilterOptions {
  const platforms = new Set<Forge>();
  const authors = new Set<string>();
  const assignees = new Set<string>();
  const labels = new Set<string>();

  for (const repository of overview.repositories) {
    platforms.add(repository.host);

    for (const item of repository.items) {
      if (item.author !== undefined) authors.add(item.author);

      for (const assignee of item.assignees) assignees.add(assignee);

      for (const label of item.labels) labels.add(label);
    }
  }

  return {
    platforms: [...platforms].toSorted(),
    repositories: overview.repositories.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    ),
    authors: [...authors].toSorted((left, right) => left.localeCompare(right)),
    assignees: [...assignees].toSorted((left, right) => left.localeCompare(right)),
    labels: [...labels].toSorted((left, right) => left.localeCompare(right)),
    knowsViewer: overview.repositories.some((repository) => repository.viewer !== undefined),
  };
}

export function isFiltered(filter: InboxFilter): boolean {
  const defaults = DEFAULT_INBOX_FILTER;

  return (
    filter.query.trim() !== "" ||
    filter.platform !== defaults.platform ||
    filter.repository !== defaults.repository ||
    filter.involvement !== defaults.involvement ||
    filter.author !== defaults.author ||
    filter.assignee !== defaults.assignee ||
    filter.label !== defaults.label
  );
}

export function sessionsNeedingAttention(
  sessions: readonly Session[],
  states: Readonly<Record<TerminalID, TerminalState>>,
  link: (sessionID: SessionID) => SessionForgeLink | undefined,
): readonly InboxSessionRow[] {
  const rows: InboxSessionRow[] = [];

  for (const session of sessions) {
    const status = sessionStatus(session, states);
    const linked = link(session.id);
    const reasons: AttentionReason[] = [];

    if (status === "unread") reasons.push("unread");

    if (status === "error") reasons.push("error");

    if (linked?.forge?.pullRequest?.state === "open" && linked.forge.checks === "failing") {
      reasons.push("checksFailing");
    }

    if (reasons.length > 0) rows.push({ session, reasons, link: linked });
  }

  return rows;
}

export function updatedAgo(updatedAt: string, now: number): string {
  const seconds = Math.round((Date.parse(updatedAt) - now) / 1000);
  const scale = RELATIVE_SCALE.find((step) => Math.abs(seconds) >= step.seconds) ?? SECONDS;

  return RELATIVE_TIME.format(Math.round(seconds / scale.seconds), scale.unit);
}

export function updatedOn(updatedAt: string): string {
  return ABSOLUTE_TIME.format(Date.parse(updatedAt));
}
