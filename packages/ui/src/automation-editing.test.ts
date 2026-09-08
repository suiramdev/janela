import { describe, expect, test } from "bun:test";

import type { AutomationCommand, AutomationEvent } from "@janela/core";
import { newAutomationID } from "@janela/core";

import {
  AUTOMATION_EVENT_TITLE,
  automationAppending,
  automationMoving,
  automationRemoving,
  automationReplacing,
  automationViolations,
  commandsForEvent,
  DEFAULT_AUTOMATION_TIMEOUT_SECONDS,
  usesTimeout,
} from "./automation-editing.ts";

function command(
  event: AutomationEvent,
  argv: readonly string[],
  overrides: Partial<AutomationCommand> = {},
): AutomationCommand {
  return {
    id: newAutomationID(),
    event,
    command: argv,
    isEnabled: true,
    timeoutSeconds: DEFAULT_AUTOMATION_TIMEOUT_SECONDS,
    ...overrides,
  };
}

describe("adding a command", () => {
  test("starts disabled, so nothing runs because a row was added to read it", () => {
    const [added] = automationAppending([], "sessionStart");
    expect(added?.isEnabled).toBe(false);
  });

  test("starts as one blank argv element, and carries the default timeout", () => {
    const [added] = automationAppending([], "sessionTeardown");
    expect(added?.command).toEqual([""]);
    expect(added?.timeoutSeconds).toBe(DEFAULT_AUTOMATION_TIMEOUT_SECONDS);
  });

  test("is appended after the existing commands, which is its run position", () => {
    const first = command("sessionStart", ["pnpm", "dev"]);
    const commands = automationAppending([first], "sessionStart");
    expect(commands).toHaveLength(2);
    expect(commands[0]?.id).toBe(first.id);
    expect(commands[1]?.command).toEqual([""]);
  });

  test("two added commands never share an id", () => {
    const once = automationAppending([], "sessionStart");
    const twice = automationAppending(once, "sessionStart");
    expect(new Set(twice.map((entry) => entry.id)).size).toBe(2);
  });
});

describe("commandsForEvent", () => {
  test("selects one event's commands, in list order", () => {
    const install = command("worktreeCreated", ["pnpm", "install"]);
    const dev = command("sessionStart", ["pnpm", "dev"]);
    const build = command("sessionStart", ["make"]);
    const down = command("sessionTeardown", ["docker", "compose", "down"]);

    expect(
      commandsForEvent([install, dev, build, down], "sessionStart").map((entry) => entry.command),
    ).toEqual([["pnpm", "dev"], ["make"]]);
  });
});

describe("replacing and removing", () => {
  test("a replacement keeps its position", () => {
    const first = command("sessionStart", ["a"]);
    const second = command("sessionStart", ["b"]);
    const edited = { ...second, command: ["b", "--flag"] };

    expect(automationReplacing([first, second], edited).map((entry) => entry.command)).toEqual([
      ["a"],
      ["b", "--flag"],
    ]);
  });

  test("removing an absent id changes nothing", () => {
    const first = command("sessionStart", ["a"]);
    expect(automationRemoving([first], newAutomationID())).toEqual([first]);
  });
});

describe("reordering within an event", () => {
  test("swaps with the neighbour sharing the event, not the adjacent row", () => {
    // The list is flat and mixes events. A naive index swap would trade the
    // sessionStart command with the worktreeCreated one sitting between them.
    const dev = command("sessionStart", ["pnpm", "dev"]);
    const install = command("worktreeCreated", ["pnpm", "install"]);
    const build = command("sessionStart", ["make"]);

    const moved = automationMoving([dev, install, build], build.id, -1);

    expect(moved.map((entry) => entry.id)).toEqual([build.id, install.id, dev.id]);
    expect(commandsForEvent(moved, "sessionStart").map((entry) => entry.command)).toEqual([
      ["make"],
      ["pnpm", "dev"],
    ]);
    expect(commandsForEvent(moved, "worktreeCreated")).toEqual([install]);
  });

  test("a command already first in its event does not wrap to the end", () => {
    const dev = command("sessionStart", ["pnpm", "dev"]);
    const build = command("sessionStart", ["make"]);
    expect(automationMoving([dev, build], dev.id, -1)).toEqual([dev, build]);
  });

  test("a command already last in its event does not wrap to the front", () => {
    const dev = command("sessionStart", ["pnpm", "dev"]);
    const build = command("sessionStart", ["make"]);
    expect(automationMoving([dev, build], build.id, 1)).toEqual([dev, build]);
  });

  test("the only command for its event never moves, whatever else is in the list", () => {
    const install = command("worktreeCreated", ["pnpm", "install"]);
    const dev = command("sessionStart", ["pnpm", "dev"]);
    const down = command("sessionTeardown", ["docker", "compose", "down"]);
    const commands = [install, dev, down];

    expect(automationMoving(commands, dev.id, -1)).toEqual(commands);
    expect(automationMoving(commands, dev.id, 1)).toEqual(commands);
  });

  test("an unknown id changes nothing", () => {
    const dev = command("sessionStart", ["pnpm", "dev"]);
    expect(automationMoving([dev], newAutomationID(), 1)).toEqual([dev]);
  });
});

describe("usesTimeout", () => {
  test("only teardown blocks, so only teardown has a meaningful timeout", () => {
    expect(usesTimeout("sessionTeardown")).toBe(true);
    expect(usesTimeout("sessionStart")).toBe(false);
    expect(usesTimeout("worktreeCreated")).toBe(false);
  });
});

describe("automationViolations", () => {
  test("an enabled command with no executable would fail at every creation", () => {
    expect(automationViolations(command("sessionStart", [""]))).toEqual([
      "An enabled command needs an executable.",
    ]);
  });

  test("a disabled blank command is just a row someone started", () => {
    expect(automationViolations(command("sessionStart", [""], { isEnabled: false }))).toEqual([]);
  });

  test("a teardown timeout of zero would make deletion not wait at all", () => {
    expect(
      automationViolations(command("sessionTeardown", ["docker"], { timeoutSeconds: 0 })),
    ).toEqual(["A teardown timeout must be at least one second."]);
  });

  test("a zero timeout on a non-blocking event is not a violation", () => {
    expect(automationViolations(command("sessionStart", ["pnpm"], { timeoutSeconds: 0 }))).toEqual(
      [],
    );
  });
});

describe("event titles", () => {
  test("every event has one, so a new event cannot render blank", () => {
    for (const event of ["worktreeCreated", "sessionStart", "sessionTeardown"] as const) {
      expect(AUTOMATION_EVENT_TITLE[event].length).toBeGreaterThan(0);
    }
  });
});
