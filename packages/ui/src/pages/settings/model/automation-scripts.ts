import type { AutomationEvent, AutomationScripts, ProjectSettings } from "@janela/core";
import { DEFAULT_AUTOMATION_TIMEOUT_SECONDS, automationScriptOf } from "@janela/core";

export const AUTOMATION_EVENT_TITLE = {
  worktreeCreated: "When a worktree is created",
  sessionStart: "When a session is first opened",
  sessionTeardown: "When a session is deleted",
} satisfies Record<AutomationEvent, string>;

export const AUTOMATION_EVENT_HINT = {
  worktreeCreated: "After the worktree exists and .worktreeinclude has finished copying.",
  sessionStart: "Once per session, not once per app launch. Restarting Janela does not re-run it.",
  sessionTeardown: "The only one deletion waits for. Past its timeout you are asked once.",
} satisfies Record<AutomationEvent, string>;

export function usesTimeout(event: AutomationEvent): boolean {
  return event === "sessionTeardown";
}

export function withAutomationScript(
  automation: AutomationScripts,
  event: AutomationEvent,
  script: string,
): AutomationScripts {
  if (script.length === 0) {
    const { [event]: _removed, ...rest } = automation;

    return rest;
  }

  const current = automation[event];

  return {
    ...automation,
    [event]: {
      script,
      timeoutSeconds: current?.timeoutSeconds ?? DEFAULT_AUTOMATION_TIMEOUT_SECONDS,
    },
  };
}

export function withAutomationTimeout(
  automation: AutomationScripts,
  event: AutomationEvent,
  timeoutSeconds: number,
): AutomationScripts {
  const current = automation[event];

  if (current === undefined) return automation;

  return {
    ...automation,
    [event]: { ...current, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 0 },
  };
}

export function automationViolations(settings: ProjectSettings): readonly string[] {
  const teardown = automationScriptOf(settings, "sessionTeardown");

  if (teardown !== undefined && teardown.timeoutSeconds <= 0) {
    return ["A teardown timeout must be at least one second."];
  }

  return [];
}
