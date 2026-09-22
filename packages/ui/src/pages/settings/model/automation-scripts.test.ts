import { describe, expect, test } from "bun:test";

import type { AutomationScripts } from "@janela/core";
import { DEFAULT_AUTOMATION_TIMEOUT_SECONDS } from "@janela/core";

import { fakeSettings } from "../../../shared/lib/test-fakes/index.ts";
import {
  automationViolations,
  withAutomationScript,
  withAutomationTimeout,
} from "./automation-scripts.ts";

const DOWN: AutomationScripts = {
  sessionTeardown: { script: "docker compose down", timeoutSeconds: 12 },
};

describe("withAutomationScript", () => {
  test("a first script takes the default timeout", () => {
    expect(withAutomationScript({}, "sessionStart", "pnpm dev")).toEqual({
      sessionStart: { script: "pnpm dev", timeoutSeconds: DEFAULT_AUTOMATION_TIMEOUT_SECONDS },
    });
  });

  test("editing the text keeps the timeout the user set", () => {
    expect(withAutomationScript(DOWN, "sessionTeardown", "make clean")).toEqual({
      sessionTeardown: { script: "make clean", timeoutSeconds: 12 },
    });
  });

  test("clearing the text removes the event, so an emptied editor stores nothing", () => {
    expect(withAutomationScript(DOWN, "sessionTeardown", "")).toEqual({});
  });

  test("touches only its own event", () => {
    const both = withAutomationScript(DOWN, "sessionStart", "pnpm dev");

    expect(both.sessionTeardown).toBe(DOWN.sessionTeardown);
  });
});

describe("withAutomationTimeout", () => {
  test("changes the timeout of a script that exists", () => {
    expect(withAutomationTimeout(DOWN, "sessionTeardown", 5)).toEqual({
      sessionTeardown: { script: "docker compose down", timeoutSeconds: 5 },
    });
  });

  test("is a no-op for an event with no script, rather than inventing one", () => {
    expect(withAutomationTimeout(DOWN, "sessionStart", 5)).toBe(DOWN);
  });

  test("a non-number reads as zero, which the violation then catches", () => {
    const result = withAutomationTimeout(DOWN, "sessionTeardown", Number.NaN);

    expect(result.sessionTeardown?.timeoutSeconds).toBe(0);
    expect(automationViolations(fakeSettings({ automation: result }))).toHaveLength(1);
  });
});

describe("automationViolations", () => {
  test("only a teardown that runs something and would never time out", () => {
    expect(automationViolations(fakeSettings({ automation: {} }))).toEqual([]);
    expect(automationViolations(fakeSettings({ automation: DOWN }))).toEqual([]);
    expect(
      automationViolations(
        fakeSettings({ automation: { sessionStart: { script: "pnpm dev", timeoutSeconds: 0 } } }),
      ),
    ).toEqual([]);

    expect(
      automationViolations(
        fakeSettings({ automation: { sessionTeardown: { script: "# soon", timeoutSeconds: 0 } } }),
      ),
    ).toEqual([]);

    expect(
      automationViolations(
        fakeSettings({
          automation: { sessionTeardown: { script: "docker compose down", timeoutSeconds: 0 } },
        }),
      ),
    ).toEqual(["A teardown timeout must be at least one second."]);
  });
});
