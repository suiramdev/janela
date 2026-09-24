import type { Instant, ProjectID, SessionID } from "./identifiers.ts";
import type { Forge } from "./project.ts";

export type ForgeItemState = "open" | "merged" | "closed";

export type CheckRollup = "passing" | "failing" | "running" | "none";

export type ForgeItemKind = "issue" | "pullRequest";

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: ForgeItemState;
  readonly isDraft: boolean;
  readonly url: string;
}

export interface ForgeState {
  readonly host: Forge;
  readonly pullRequest?: PullRequestSummary;
  readonly checks?: CheckRollup;
  readonly refreshedAt: Instant;
}

export interface ForgeItem {
  readonly kind: ForgeItemKind;
  readonly number: number;
  readonly title: string;
  readonly state: ForgeItemState;
  readonly isDraft: boolean;
  readonly url: string;
  readonly author?: string;
  readonly assignees: readonly string[];
  readonly reviewers: readonly string[];
  readonly labels: readonly string[];
  readonly branch?: string;
  readonly updatedAt: Instant;
}

export interface ForgeItems {
  readonly viewer?: string;
  readonly items: readonly ForgeItem[];
}

export interface ForgeRepository {
  readonly projectID: ProjectID;
  readonly host: Forge;
  readonly name: string;
  readonly isAvailable: boolean;
  readonly viewer?: string;
  readonly items: readonly ForgeItem[];
}

export interface SessionForgeLink {
  readonly sessionID: SessionID;
  readonly branch?: string;
  readonly forge?: ForgeState;
}

export interface ForgeOverview {
  readonly repositories: readonly ForgeRepository[];
  readonly sessions: readonly SessionForgeLink[];
}

export const FORGE_TITLE = {
  gitHub: "GitHub",
  gitLab: "GitLab",
} as const satisfies Record<Forge, string>;

export function isWebURL(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}
