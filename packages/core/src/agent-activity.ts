import { Match } from "effect";

import type { AgentActivity, AgentNeed, AgentOutcome } from "./terminal.ts";

export const AGENT_ACTIVITY_OSC = 7770;

const OSC_INTRODUCER = "\x1b]";

const BEL = "\x07";

const SEPARATOR = ";";

const NEEDS: readonly AgentNeed[] = ["permission", "input"];

const OUTCOMES: readonly AgentOutcome[] = ["completed", "failed"];

export function formatAgentActivity(activity: AgentActivity): string {
  return Match.value(activity).pipe(
    Match.when({ kind: "working" }, () => "working"),
    Match.when({ kind: "waiting" }, (waiting) => `waiting${SEPARATOR}${waiting.need}`),
    Match.when({ kind: "finished" }, (finished) => `finished${SEPARATOR}${finished.outcome}`),
    Match.exhaustive,
  );
}

export function agentActivityEscape(activity: AgentActivity): string {
  return `${OSC_INTRODUCER}${AGENT_ACTIVITY_OSC}${SEPARATOR}${formatAgentActivity(activity)}${BEL}`;
}

export function parseAgentActivity(payload: string): AgentActivity | undefined {
  const [kind, qualifier, ...rest] = payload.split(SEPARATOR);

  if (rest.length > 0) return undefined;

  if (kind === "working") return qualifier === undefined ? { kind: "working" } : undefined;

  if (kind === "waiting") {
    const need = NEEDS.find((candidate) => candidate === qualifier);

    return need === undefined ? undefined : { kind: "waiting", need };
  }

  if (kind === "finished") {
    const outcome = OUTCOMES.find((candidate) => candidate === qualifier);

    return outcome === undefined ? undefined : { kind: "finished", outcome };
  }

  return undefined;
}

export function agentActivityText(activity: AgentActivity): string {
  return Match.value(activity).pipe(
    Match.when({ kind: "working" }, () => "working"),
    Match.when({ kind: "waiting", need: "permission" }, () => "waiting for permission"),
    Match.when({ kind: "waiting", need: "input" }, () => "waiting for your answer"),
    Match.when({ kind: "finished", outcome: "completed" }, () => "finished"),
    Match.when({ kind: "finished", outcome: "failed" }, () => "stopped with an error"),
    Match.exhaustive,
  );
}
