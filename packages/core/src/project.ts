import type { Accent } from "./accent.ts";
import type {
  AbsolutePath,
  AutomationID,
  Instant,
  LaunchProfileID,
  ProjectID,
} from "./identifiers.ts";

export interface Project {
  readonly id: ProjectID;
  name: string;
  directory: AbsolutePath;
  git?: GitDescriptor;
  settings: ProjectSettings;
  accent: Accent;
  isExpanded: boolean;
  addedAt: Instant;
}

export interface GitDescriptor {
  remoteURL?: string;
  defaultBranch?: string;
  forge?: Forge;
}

export type Forge = "gitHub" | "gitLab";

export interface ProjectSettings {
  worktreeRoot: WorktreeRoot;
  automation: readonly AutomationCommand[];
  defaultProfileID?: LaunchProfileID;
  isForgeEnabled: boolean;
}

export type WorktreeRoot =
  | { readonly kind: "siblingDirectory" }
  | { readonly kind: "custom"; readonly directory: AbsolutePath };

export interface AutomationCommand {
  readonly id: AutomationID;
  event: AutomationEvent;
  command: readonly string[];
  isEnabled: boolean;
  timeoutSeconds: number;
}

export type AutomationEvent = "worktreeCreated" | "sessionStart" | "sessionTeardown";

export const AUTOMATION_EVENTS: readonly AutomationEvent[] = [
  "worktreeCreated",
  "sessionStart",
  "sessionTeardown",
];

export function supportsWorktrees(project: Project): boolean {
  return project.git !== undefined;
}

export function forgeExecutable(forge: Forge): string {
  return forge === "gitHub" ? "gh" : "glab";
}
