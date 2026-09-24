import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Task01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@janela/design";
import type { ReactElement } from "react";

import {
  CHECKS_TITLE,
  PULL_REQUEST_STATUS_TITLE,
  type PullRequestStatus,
  type ReportedChecks,
} from "../model/session-forge.ts";

type HugeIcon = typeof GitPullRequestIcon;

const STATUS_ICON = {
  open: { icon: GitPullRequestIcon, tint: "text-success" },
  draft: { icon: GitPullRequestDraftIcon, tint: "text-muted-foreground" },
  merged: { icon: GitMergeIcon, tint: "text-foreground/70" },
  closed: { icon: GitPullRequestClosedIcon, tint: "text-failure" },
} as const satisfies Record<PullRequestStatus, { readonly icon: HugeIcon; readonly tint: string }>;

const ISSUE_TINT = {
  open: "text-success",
  draft: "text-muted-foreground",
  merged: "text-foreground/70",
  closed: "text-muted-foreground",
} as const satisfies Record<PullRequestStatus, string>;

const CHECKS_ICON = {
  passing: { icon: CheckmarkCircle02Icon, tint: "text-success" },
  failing: { icon: CancelCircleIcon, tint: "text-failure" },
  running: { icon: Clock01Icon, tint: "text-attention" },
} as const satisfies Record<ReportedChecks, { readonly icon: HugeIcon; readonly tint: string }>;

export function BranchMark(props: {
  readonly branch: string;
  readonly className?: string | undefined;
}): ReactElement {
  return (
    <span className={cn("flex min-w-0 items-center gap-1", props.className)} title={props.branch}>
      <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate font-mono">{props.branch}</span>
    </span>
  );
}

export function PullRequestMark(props: {
  readonly status: PullRequestStatus | undefined;
  readonly reference: string | undefined;
  readonly title: string | undefined;
  readonly className?: string | undefined;
}): ReactElement {
  const { status, reference, title } = props;
  const shape = status === undefined ? { icon: GitPullRequestIcon, tint: "" } : STATUS_ICON[status];
  const label = [
    reference,
    status === undefined ? undefined : PULL_REQUEST_STATUS_TITLE[status],
    title,
  ]
    .filter((part) => part !== undefined)
    .join(" — ");

  return (
    <span className={cn("flex min-w-0 items-center gap-1", props.className)} title={label}>
      <HugeiconsIcon
        icon={shape.icon}
        size={12}
        strokeWidth={1.75}
        className={cn("shrink-0", shape.tint)}
      />
      {status !== undefined && reference === undefined && title === undefined ? (
        <span className="sr-only">{PULL_REQUEST_STATUS_TITLE[status]}</span>
      ) : undefined}
      {reference === undefined ? undefined : (
        <span className="shrink-0 tabular-nums">{reference}</span>
      )}
      {title === undefined ? undefined : <span className="min-w-0 truncate">{title}</span>}
    </span>
  );
}

export function ChecksMark(props: { readonly checks: ReportedChecks }): ReactElement {
  const shape = CHECKS_ICON[props.checks];

  return (
    <span className="flex shrink-0 items-center" title={CHECKS_TITLE[props.checks]}>
      <HugeiconsIcon
        icon={shape.icon}
        size={12}
        strokeWidth={1.75}
        className={shape.tint}
        aria-hidden="true"
      />
      <span className="sr-only">{CHECKS_TITLE[props.checks]}</span>
    </span>
  );
}

export function ItemKindIcon(props: {
  readonly kind: "issue" | "pullRequest";
  readonly status: PullRequestStatus;
}): ReactElement {
  const shape =
    props.kind === "pullRequest"
      ? STATUS_ICON[props.status]
      : { icon: Task01Icon, tint: ISSUE_TINT[props.status] };

  return (
    <HugeiconsIcon
      icon={shape.icon}
      size={16}
      strokeWidth={1.75}
      className={cn("shrink-0", shape.tint)}
      aria-hidden="true"
    />
  );
}
