import type { Instant, Forge, Project, Session } from "@janela/core";

export interface ForgeState {
  readonly host: Forge;
  readonly pullRequest?: PullRequestSummary;
  readonly checks?: CheckRollup;
  readonly refreshedAt: Instant;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
  readonly url: string;
}

export type CheckRollup = "passing" | "failing" | "running" | "none";

export interface ForgeServing {
  isAvailable(host: Forge): Promise<boolean>;

  state(request: {
    readonly project: Project;
    readonly session: Session;
  }): Promise<ForgeState | undefined>;

  pullRequestBranch(request: {
    readonly project: Project;
    readonly number: number;
  }): Promise<string | undefined>;
}

export * from "./forge-service.ts";
