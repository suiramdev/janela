import { describe, expect, test } from "bun:test";

import { splitFocusing, terminalID } from "./session-fixture.ts";
import { closeQuestionScope, tabTerminals } from "./tab-rows.ts";

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
