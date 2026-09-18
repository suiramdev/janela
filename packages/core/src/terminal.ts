import type { AbsolutePath, Instant, TerminalID } from "./identifiers.ts";
import type { AutomationEvent } from "./project.ts";

export interface TerminalDescriptor {
  readonly id: TerminalID;
  title: string;
  workingDirectoryOverride?: AbsolutePath;
  startsAutomatically: boolean;
  role: TerminalRole;
  createdAt: Instant;
}

export type TerminalRole =
  | { readonly kind: "user" }
  | { readonly kind: "automation"; readonly event: AutomationEvent };

export type TerminalProgress =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "normal"; readonly percent: number }
  | { readonly kind: "error"; readonly percent: number }
  | { readonly kind: "warning"; readonly percent: number };

export type AgentActivity =
  | { readonly kind: "working" }
  | { readonly kind: "waiting"; readonly need: AgentNeed }
  | { readonly kind: "finished"; readonly outcome: AgentOutcome };

export type AgentNeed = "permission" | "input";

export type AgentOutcome = "completed" | "failed";

export type TerminalState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly progress?: TerminalProgress;
      readonly activity?: AgentActivity;
    }
  | { readonly kind: "needsAttention"; readonly activity?: AgentActivity }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "failed"; readonly message: string };

export interface GridSize {
  readonly columns: number;
  readonly rows: number;
}

export function isLive(state: TerminalState): boolean {
  return state.kind === "running" || state.kind === "needsAttention";
}
