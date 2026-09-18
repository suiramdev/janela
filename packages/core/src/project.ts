import type { Accent } from "./accent.ts";
import type { AbsolutePath, Instant, ProjectID } from "./identifiers.ts";

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
  automation: AutomationScripts;
}

export type WorktreeRoot =
  | { readonly kind: "siblingDirectory" }
  | { readonly kind: "custom"; readonly directory: AbsolutePath };

export type AutomationScripts = Partial<Readonly<Record<AutomationEvent, AutomationScript>>>;

export interface AutomationScript {
  script: string;
  timeoutSeconds: number;
}

export type AutomationEvent = "worktreeCreated" | "sessionStart" | "sessionTeardown";

export interface AutomationVariable {
  readonly name: string;
  readonly meaning: string;
}

export const AUTOMATION_EVENTS: readonly AutomationEvent[] = [
  "worktreeCreated",
  "sessionStart",
  "sessionTeardown",
];

export const DEFAULT_AUTOMATION_TIMEOUT_SECONDS = 30;

export const AUTOMATION_VARIABLES: readonly AutomationVariable[] = [
  { name: "JANELA_PROJECT_DIRECTORY", meaning: "the project's own directory" },
  {
    name: "JANELA_SESSION_DIRECTORY",
    meaning: "where the session runs — its worktree, when it has one; also the working directory",
  },
  { name: "JANELA_SESSION_NAME", meaning: "the session's name" },
  { name: "JANELA_BRANCH", meaning: "the worktree's branch; absent on a simple session" },
  { name: "JANELA_PROJECT", meaning: "the project's name" },
  { name: "JANELA_AUTOMATION_EVENT", meaning: "which event this script runs for" },
];

export function scriptRunsAnything(script: string): boolean {
  return script.split("\n").some((line) => {
    const trimmed = line.trim();

    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
}

export function automationScriptOf(
  settings: ProjectSettings,
  event: AutomationEvent,
): AutomationScript | undefined {
  const entry = settings.automation[event];

  return entry === undefined || !scriptRunsAnything(entry.script) ? undefined : entry;
}

export function supportsWorktrees(project: Project): boolean {
  return project.git !== undefined;
}

export function forgeExecutable(forge: Forge): string {
  return forge === "gitHub" ? "gh" : "glab";
}
