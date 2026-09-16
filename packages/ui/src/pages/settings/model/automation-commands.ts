import type { AutomationCommand, AutomationEvent, AutomationID } from "@janela/core";
import { newAutomationID } from "@janela/core";

export const DEFAULT_AUTOMATION_TIMEOUT_SECONDS = 30;

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

export function automationAppending(
  commands: readonly AutomationCommand[],
  event: AutomationEvent,
): readonly AutomationCommand[] {
  return [
    ...commands,
    {
      id: newAutomationID(),
      event,
      command: [""],
      isEnabled: false,
      timeoutSeconds: DEFAULT_AUTOMATION_TIMEOUT_SECONDS,
    },
  ];
}

export function automationReplacing(
  commands: readonly AutomationCommand[],
  replacement: AutomationCommand,
): readonly AutomationCommand[] {
  return commands.map((command) => (command.id === replacement.id ? replacement : command));
}

export function automationRemoving(
  commands: readonly AutomationCommand[],
  id: AutomationID,
): readonly AutomationCommand[] {
  return commands.filter((command) => command.id !== id);
}

export function commandsForEvent(
  commands: readonly AutomationCommand[],
  event: AutomationEvent,
): readonly AutomationCommand[] {
  return commands.filter((command) => command.event === event);
}

export function automationMoving(
  commands: readonly AutomationCommand[],
  id: AutomationID,
  delta: -1 | 1,
): readonly AutomationCommand[] {
  const from = commands.findIndex((command) => command.id === id);
  const moving = commands[from];

  if (moving === undefined) return commands;

  let to = from + delta;

  while (to >= 0 && to < commands.length && commands[to]?.event !== moving.event) to += delta;

  const target = to >= 0 && to < commands.length ? commands[to] : undefined;

  if (target === undefined) return commands;

  const reordered = [...commands];
  reordered[from] = target;
  reordered[to] = moving;

  return reordered;
}

export function automationViolations(command: AutomationCommand): readonly string[] {
  const violations: string[] = [];
  const executable = command.command[0];

  if (command.isEnabled && (executable === undefined || executable.trim().length === 0)) {
    violations.push("An enabled command needs an executable.");
  }

  if (usesTimeout(command.event) && command.timeoutSeconds <= 0) {
    violations.push("A teardown timeout must be at least one second.");
  }

  return violations;
}
