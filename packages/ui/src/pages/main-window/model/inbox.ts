import {
  FORGE_TITLE,
  type Forge,
  type ForgeItem,
  type ForgeItemKind,
  type ForgeOverview,
  type ForgeRepository,
  type Session,
  type SessionForgeLink,
  type SessionID,
  type TerminalID,
  type TerminalState,
} from "@janela/core";

import {
  EMPTY_SEARCH,
  searchFilters,
  searchQuery,
  type SearchField,
  type SearchFilterToken,
  type SearchState,
  type SearchValue,
} from "./filtered-search.ts";
import { sessionStatus } from "./session-rows.ts";

export type InboxKind = ForgeItemKind;

export type InboxStatus = "open" | "merged" | "closed" | "all";

export type InboxSort = "updatedNewest" | "updatedOldest" | "numberHighest" | "numberLowest";

export type InboxInvolvement = "assigned" | "authored" | "reviewRequested";

export type InboxSearchField =
  | "author"
  | "assignee"
  | "label"
  | "involvement"
  | "repository"
  | "platform";

export type AttentionReason = "unread" | "error" | "checksFailing";

export interface InboxFilter {
  readonly kind: InboxKind;
  readonly status: InboxStatus;
  readonly sort: InboxSort;
  readonly search: SearchState;
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
  sort: "updatedNewest",
  search: EMPTY_SEARCH,
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
  assigned: "Assigned to me",
  authored: "Opened by me",
  reviewRequested: "Review requested",
} as const satisfies Record<InboxInvolvement, string>;

export const INBOX_SEARCH_FIELD_TITLE = {
  author: "Author",
  assignee: "Assignee",
  label: "Label",
  involvement: "Involvement",
  repository: "Repository",
  platform: "Platform",
} as const satisfies Record<InboxSearchField, string>;

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
  "assigned",
  "authored",
  "reviewRequested",
];

const INBOX_SEARCH_FIELDS: readonly InboxSearchField[] = [
  "author",
  "assignee",
  "label",
  "involvement",
  "repository",
  "platform",
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

const FIELD_MATCHES = {
  author: (item, _repository, value) => item.author === value,
  assignee: (item, _repository, value) => item.assignees.includes(value),
  label: (item, _repository, value) => item.labels.includes(value),
  involvement: (item, repository, value) =>
    INBOX_INVOLVEMENTS.some(
      (involvement) => involvement === value && isInvolved(item, repository.viewer, involvement),
    ),
  repository: (_item, repository, value) => repository.projectID === value,
  platform: (_item, repository, value) => repository.host === value,
} as const satisfies Record<
  InboxSearchField,
  (item: ForgeItem, repository: ForgeRepository, value: string) => boolean
>;

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const ABSOLUTE_TIME = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function isInvolved(
  item: ForgeItem,
  viewer: string | undefined,
  involvement: InboxInvolvement,
): boolean {
  if (viewer === undefined) return false;

  if (involvement === "assigned") return item.assignees.includes(viewer);

  if (involvement === "authored") return item.author === viewer;

  return item.reviewers.includes(viewer);
}

export function matchesSearchFilter(
  item: ForgeItem,
  repository: ForgeRepository,
  token: SearchFilterToken,
): boolean {
  const field = INBOX_SEARCH_FIELDS.find((candidate) => candidate === token.field);

  if (field === undefined) return true;

  return FIELD_MATCHES[field](item, repository, token.value) === (token.operator === "is");
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
  const query = searchQuery(filter.search);
  const filters = searchFilters(filter.search);

  for (const repository of overview.repositories) {
    for (const item of repository.items) {
      if (item.kind !== filter.kind) continue;

      if (!matchesQuery(item, repository, query)) continue;

      if (!filters.every((token) => matchesSearchFilter(item, repository, token))) continue;

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

export function inboxSearchFields(options: InboxFilterOptions): readonly SearchField[] {
  const values = {
    author: namedValues(options.authors),
    assignee: namedValues(options.assignees),
    label: namedValues(options.labels),
    involvement: options.knowsViewer
      ? INBOX_INVOLVEMENTS.map((involvement) => ({
          value: involvement,
          title: INBOX_INVOLVEMENT_TITLE[involvement],
        }))
      : [],
    repository:
      options.repositories.length > 1
        ? options.repositories.map((repository) => ({
            value: repository.projectID,
            title: repository.name,
          }))
        : [],
    platform:
      options.platforms.length > 1
        ? options.platforms.map((platform) => ({ value: platform, title: FORGE_TITLE[platform] }))
        : [],
  } as const satisfies Record<InboxSearchField, readonly SearchValue[]>;

  return INBOX_SEARCH_FIELDS.map((field) => ({
    key: field,
    title: INBOX_SEARCH_FIELD_TITLE[field],
    values: values[field],
    isPerson: field === "author" || field === "assignee",
    takesMany: field === "assignee" || field === "label",
  }));
}

function namedValues(names: readonly string[]): readonly SearchValue[] {
  return names.map((name) => ({ value: name, title: name }));
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
