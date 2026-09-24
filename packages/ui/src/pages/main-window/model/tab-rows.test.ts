import { describe, expect, test } from "bun:test";

import type { TerminalState } from "@janela/core";

import { splitFocusing, terminalID } from "./session-fixture.ts";
import {
  closeQuestionScope,
  isFailureState,
  tabTerminals,
  paneStateText,
  terminalStateText,
} from "./tab-rows.ts";

const WAITING: TerminalState = {
  kind: "needsAttention",
  activity: { kind: "waiting", need: "permission" },
};

const FINISHED: TerminalState = {
  kind: "needsAttention",
  activity: { kind: "finished", outcome: "completed" },
};

const STOPPED: TerminalState = {
  kind: "needsAttention",
  activity: { kind: "finished", outcome: "failed" },
};

describe("tabTerminals", () => {
  test("a tab is every terminal in its tree, not the pane it happens to show", () => {
    const layout = splitFocusing(terminalID("t2"));

    expect(tabTerminals(layout, 0)).toEqual([terminalID("t1"), terminalID("t2")]);
    expect(tabTerminals(layout, 1)).toEqual([]);
  });
});

describe("closeQuestionScope", () => {
  test("only the tab's own ✕ asks about this tab", () => {
    expect(closeQuestionScope("this")).toBe("tab");

    for (const scope of ["others", "left", "right", "all"] as const) {
      expect(closeQuestionScope(scope)).toBe("tabs");
    }
  });
});

describe("terminalStateText", () => {
  test("a terminal reads out what the agent said, when it said anything", () => {
    expect(terminalStateText({ kind: "running", activity: { kind: "working" } })).toBe("working");
    expect(terminalStateText(WAITING)).toBe("waiting for permission");
    expect(terminalStateText(FINISHED)).toBe("finished");
    expect(terminalStateText(STOPPED)).toBe("stopped with an error");
  });

  test("a terminal with nothing reported still reads out its own state", () => {
    expect(terminalStateText(undefined)).toBe("idle");
    expect(terminalStateText({ kind: "running" })).toBe("running");
    expect(terminalStateText({ kind: "needsAttention" })).toBe("needs attention");
    expect(terminalStateText({ kind: "exited", code: 130 })).toBe("exited (130)");
    expect(terminalStateText({ kind: "failed", message: "no such file" })).toBe("no such file");
  });
});

describe("paneStateText", () => {
  test("a terminal simply running is not badged, whatever the agent is doing in it", () => {
    expect(paneStateText({ kind: "running" })).toBeUndefined();
    expect(paneStateText({ kind: "running", activity: { kind: "working" } })).toBeUndefined();
    expect(paneStateText({ kind: "running", progress: { kind: "indeterminate" } })).toBeUndefined();
  });

  test("an agent waiting or finished is badged with what it said", () => {
    expect(paneStateText(WAITING)).toBe("waiting for permission");
    expect(paneStateText(FINISHED)).toBe("finished");
    expect(paneStateText(STOPPED)).toBe("stopped with an error");
  });

  test("attention nobody explained is left to the bell, not spelled out in a badge", () => {
    expect(paneStateText({ kind: "needsAttention" })).toBeUndefined();
  });

  test("a terminal that is not running says so", () => {
    expect(paneStateText(undefined)).toBe("idle");
    expect(paneStateText({ kind: "idle" })).toBe("idle");
    expect(paneStateText({ kind: "exited", code: 0 })).toBe("exited (0)");
  });
});

describe("isFailureState", () => {
  test("an agent that stopped with an error is a failure, one that finished is not", () => {
    expect(isFailureState(STOPPED)).toBe(true);
    expect(isFailureState(FINISHED)).toBe(false);
    expect(isFailureState(WAITING)).toBe(false);
  });

  test("a bad exit and a failed spawn are failures, a clean exit is not", () => {
    expect(isFailureState({ kind: "exited", code: 1 })).toBe(true);
    expect(isFailureState({ kind: "exited", code: 0 })).toBe(false);
    expect(isFailureState({ kind: "failed", message: "no such file" })).toBe(true);
    expect(isFailureState(undefined)).toBe(false);
  });
});
