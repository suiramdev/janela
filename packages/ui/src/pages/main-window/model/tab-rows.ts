import {
  agentActivityText,
  paneTerminalIDs,
  type LayoutTab,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { Match } from "effect";

import type { TabCloseScope } from "../../../shared/model/index.ts";
import type { CloseScope } from "./command-dispatch.ts";

const NO_TERMINAL_IDS: readonly TerminalID[] = [];

export function tabLabel(tab: LayoutTab, terminals: readonly TerminalDescriptor[]): string {
  if (tab.title !== undefined) return tab.title;

  return terminals.find((terminal) => terminal.id === tab.focusedTerminalID)?.title ?? "Terminal";
}

export function tabTerminals(layout: SessionLayout, index: number): readonly TerminalID[] {
  const tab = layout.tabs[index];

  return tab === undefined ? NO_TERMINAL_IDS : paneTerminalIDs(tab.root);
}

export function closeQuestionScope(scope: TabCloseScope): CloseScope {
  return scope === "this" ? "tab" : "tabs";
}

export function terminalStateText(state: TerminalState | undefined): string {
  if (state === undefined) return "idle";

  return Match.value(state).pipe(
    Match.when({ kind: "idle" }, () => "idle"),
    Match.when({ kind: "running" }, (running) =>
      running.activity === undefined ? "running" : agentActivityText(running.activity),
    ),
    Match.when({ kind: "needsAttention" }, (attention) =>
      attention.activity === undefined ? "needs attention" : agentActivityText(attention.activity),
    ),
    Match.when({ kind: "exited" }, (exited) => `exited (${exited.code})`),
    Match.when({ kind: "failed" }, (failed) => failed.message),
    Match.exhaustive,
  );
}

export function terminalBadgeText(state: TerminalState | undefined): string | undefined {
  if (state?.kind === "running") return undefined;

  if (state?.kind === "needsAttention") {
    const activity = state.activity;

    if (activity === undefined || activity.kind === "working") return undefined;

    return agentActivityText(activity);
  }

  return terminalStateText(state);
}

export function isFailureState(state: TerminalState | undefined): boolean {
  if (state === undefined) return false;

  if (state.kind === "needsAttention") {
    return state.activity?.kind === "finished" && state.activity.outcome === "failed";
  }

  return state.kind === "failed" || (state.kind === "exited" && state.code !== 0);
}
