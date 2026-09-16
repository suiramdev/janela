import { Match } from "effect";

import type { Accent } from "./accent.ts";
import type { AbsolutePath, Instant, ProjectID, SessionID } from "./identifiers.ts";
import type { SessionLayout } from "./session-layout.ts";
import type { TerminalDescriptor } from "./terminal.ts";

export interface Session {
  readonly id: SessionID;
  projectID?: ProjectID;
  name: string;
  directory: AbsolutePath;
  backing: Backing;
  terminals: readonly TerminalDescriptor[];
  layout: SessionLayout;
  accent: Accent;
  createdAt: Instant;
  lastActiveAt: Instant;
  isPinned: boolean;
}

export type Backing =
  | { readonly kind: "folder" }
  | { readonly kind: "projectDirectory" }
  | { readonly kind: "worktree"; readonly binding: WorktreeBinding };

export interface WorktreeBinding {
  branch?: string;
  baseCommit?: string;
  path: AbsolutePath;
  ownership: WorktreeOwnership;
  includedPaths: readonly string[];
}

export type WorktreeOwnership = "managed" | "adopted";

export function worktreeOf(session: Session): WorktreeBinding | undefined {
  return session.backing.kind === "worktree" ? session.backing.binding : undefined;
}

export function isStandalone(session: Session): boolean {
  return session.projectID === undefined;
}

export function ownsItsDirectory(session: Session): boolean {
  return session.backing.kind === "worktree" && session.backing.binding.ownership === "managed";
}

export function backingViolations(session: Session): readonly string[] {
  const hasProject = session.projectID !== undefined;

  return Match.value(session.backing).pipe(
    Match.when({ kind: "folder" }, () =>
      hasProject ? ["folder backing must not belong to a project"] : [],
    ),
    Match.when({ kind: "projectDirectory" }, () =>
      hasProject ? [] : ["projectDirectory backing requires a project"],
    ),
    Match.when({ kind: "worktree" }, () =>
      hasProject ? [] : ["worktree backing requires a project"],
    ),
    Match.exhaustive,
  );
}
