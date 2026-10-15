import {
  AGENT_ACTIVITY_OSC,
  AGENT_PROMPT_REPORT,
  MAX_FORWARDED_PROMPT_BYTES,
  agentActivityEscape,
  formatAgentActivity,
  type AgentActivity,
} from "@janela/core";

export const TTY_VARIABLE = "JANELA_TTY";

const TTY_REFERENCE = `$${TTY_VARIABLE}`;

const OSC_MARKER = `]${AGENT_ACTIVITY_OSC};`;

export const ACTIVITIES = {
  working: { kind: "working" },
  waitingPermission: { kind: "waiting", need: "permission" },
  waitingInput: { kind: "waiting", need: "input" },
  finishedCompleted: { kind: "finished", outcome: "completed" },
  finishedFailed: { kind: "finished", outcome: "failed" },
} as const satisfies Readonly<Record<string, AgentActivity>>;

export function hookCommand(activity: AgentActivity): string {
  return [
    `[ -n "${TTY_REFERENCE}" ] &&`,
    `printf '\\033${OSC_MARKER}${formatAgentActivity(activity)}\\a' > "${TTY_REFERENCE}" 2>/dev/null;`,
    "printf '{}'",
  ].join(" ");
}

export function promptForwardCommand(): string {
  const encoded = `$(head -c ${MAX_FORWARDED_PROMPT_BYTES} | base64 | tr -d '\\n')`;

  return [
    `[ -n "${TTY_REFERENCE}" ] &&`,
    `printf '\\033${OSC_MARKER}${AGENT_PROMPT_REPORT};%s\\a' "${encoded}" > "${TTY_REFERENCE}" 2>/dev/null;`,
    "printf '{}'",
  ].join(" ");
}

export function isJanelaHookCommand(command: string): boolean {
  return command.includes(OSC_MARKER) && command.includes(TTY_REFERENCE);
}

export function activityEscapeSource(): string {
  return Object.entries(ACTIVITIES)
    .map(([name, activity]) => `  ${name}: ${JSON.stringify(agentActivityEscape(activity))},`)
    .join("\n");
}
