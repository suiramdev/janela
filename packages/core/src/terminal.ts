import type { AbsolutePath, Instant, LaunchProfileID, TerminalID } from "./identifiers.ts";
import type { AutomationEvent } from "./project.ts";

export interface TerminalDescriptor {
  readonly id: TerminalID;
  title: string;
  profileID?: LaunchProfileID;
  workingDirectoryOverride?: AbsolutePath;
  startsAutomatically: boolean;
  role: TerminalRole;
  createdAt: Instant;
}

export type TerminalRole =
  | { readonly kind: "user" }
  | { readonly kind: "automation"; readonly event: AutomationEvent };

export type TerminalState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "needsAttention" }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "failed"; readonly message: string };

export interface GridSize {
  readonly columns: number;
  readonly rows: number;
}

export function isLive(state: TerminalState): boolean {
  return state.kind === "running" || state.kind === "needsAttention";
}
