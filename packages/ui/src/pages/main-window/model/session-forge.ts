import type { CheckRollup, Forge, ForgeItemState, SessionForgeLink } from "@janela/core";
import { FORGE_TITLE } from "@janela/core";

export type PullRequestStatus = "open" | "draft" | "merged" | "closed";

export type ReportedChecks = Exclude<CheckRollup, "none">;

export interface PullRequestLink {
  readonly url: string;
  readonly label: string;
}

export type SessionRowDetails =
  | { readonly kind: "branch"; readonly branch: string }
  | {
      readonly kind: "pullRequest";
      readonly reference: string;
      readonly status: PullRequestStatus;
      readonly checks: ReportedChecks | undefined;
      readonly link: PullRequestLink;
    };

export const PULL_REQUEST_STATUS_TITLE = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
} as const satisfies Record<PullRequestStatus, string>;

export const CHECKS_TITLE = {
  passing: "Checks passed",
  failing: "Checks failed",
  running: "Checks running",
} as const satisfies Record<ReportedChecks, string>;

export function pullRequestStatus(pullRequest: {
  readonly state: ForgeItemState;
  readonly isDraft: boolean;
}): PullRequestStatus {
  return pullRequest.state === "open" && pullRequest.isDraft ? "draft" : pullRequest.state;
}

export function pullRequestNoun(host: Forge): string {
  return host === "gitHub" ? "pull request" : "merge request";
}

export function itemReference(host: Forge, kind: "issue" | "pullRequest", number: number): string {
  return host === "gitLab" && kind === "pullRequest" ? `!${number}` : `#${number}`;
}

export function openLinkLabel(host: Forge, kind: "issue" | "pullRequest", number: number): string {
  const noun = kind === "issue" ? "issue" : pullRequestNoun(host);

  return `Open ${noun} ${itemReference(host, kind, number)} on ${FORGE_TITLE[host]}`;
}

export function sessionRowDetails(
  link: SessionForgeLink | undefined,
): SessionRowDetails | undefined {
  const forge = link?.forge;
  const pullRequest = forge?.pullRequest;

  if (forge !== undefined && pullRequest !== undefined) {
    return {
      kind: "pullRequest",
      reference: itemReference(forge.host, "pullRequest", pullRequest.number),
      status: pullRequestStatus(pullRequest),
      checks: forge.checks === undefined || forge.checks === "none" ? undefined : forge.checks,
      link: {
        url: pullRequest.url,
        label: openLinkLabel(forge.host, "pullRequest", pullRequest.number),
      },
    };
  }

  return link?.branch === undefined ? undefined : { kind: "branch", branch: link.branch };
}
