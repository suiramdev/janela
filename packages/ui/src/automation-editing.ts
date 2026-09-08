import type { AutomationCommand, AutomationEvent, AutomationID } from "@janela/core";
import { newAutomationID } from "@janela/core";

/**
 * Editing a project's automation commands, as pure functions over the list.
 *
 * The list is authored here and executed by the daemon (#27). Two properties of
 * the data are load-bearing and neither is this file's invention:
 *
 * - `command` is an **argv array**, never a shell string. Same rule and same
 *   reason as a launch profile's.
 * - The commands live in Janela's database and never in the repository, because a
 *   committed file that runs commands makes cloning a repo a code-execution
 *   vector. So this editor is the *only* way one gets created: a human typing it
 *   into this app. See docs/decisions/0014-project-automation.md.
 */

/** ADR 0014's default: deletion waits 30 s for a teardown command, then asks. */
export const DEFAULT_AUTOMATION_TIMEOUT_SECONDS = 30;

/**
 * Whether this command's timeout means anything.
 *
 * `sessionTeardown` is the only blocking event — the other two never hold
 * anything up, so showing them a timeout field would imply a guarantee that does
 * not exist.
 */
export function usesTimeout(event: AutomationEvent): boolean {
  return event === "sessionTeardown";
}

/**
 * Appends a new command for `event`, **disabled**.
 *
 * Off by default is the rule from `AutomationCommand.isEnabled`: nothing may run
 * because the user clicked "add" to see what the field looked like.
 */
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

/** Replaces one command in place, keeping its position in the list. */
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

/**
 * The commands for one event, in the order they will run.
 *
 * Order is the list's order: commands for one event run in sequence and do not
 * gate each other, so this is the whole scheduling model.
 */
export function commandsForEvent(
  commands: readonly AutomationCommand[],
  event: AutomationEvent,
): readonly AutomationCommand[] {
  return commands.filter((command) => command.event === event);
}

/**
 * Moves a command earlier or later **within its own event**.
 *
 * The stored list is flat and mixes events, so a naive index swap would trade
 * places with whatever happened to sit next to it — reordering a `sessionStart`
 * command by moving a `worktreeCreated` one. This finds the nearest neighbour
 * sharing the event and swaps with that. A command already at its end is
 * returned unchanged rather than wrapping, because a run order is not a carousel.
 */
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

/**
 * Why this command cannot run, empty when it can.
 *
 * An enabled command with no executable is the case worth catching: it would fail
 * at every session creation, visibly, forever, and the user would have to read a
 * terminal to find out why. A *disabled* blank command is just a row someone
 * started.
 */
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

/** Titles for the three events, in the order the settings surface lists them. */
export const AUTOMATION_EVENT_TITLE: Record<AutomationEvent, string> = {
  worktreeCreated: "When a worktree is created",
  sessionStart: "When a session is first opened",
  sessionTeardown: "When a session is deleted",
};

/** What each event is for, in the user's terms. */
export const AUTOMATION_EVENT_HINT: Record<AutomationEvent, string> = {
  worktreeCreated: "After the worktree exists and .worktreeinclude has finished copying.",
  sessionStart: "Once per session, not once per app launch. Restarting Janela does not re-run it.",
  sessionTeardown: "The only one deletion waits for. Past its timeout you are asked once.",
};
