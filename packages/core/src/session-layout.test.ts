import { describe, expect, test } from "bun:test";

import { FRACTION_RANGE, MAXIMUM_PANE_DEPTH, emptyLayout } from "./session-layout.ts";

/**
 * The layout algebra itself is a TODO seam, so these pin the *bounds* it will be
 * written against. They are here from the first commit because they are the rules
 * docs/decisions/0010-terminal-layout.md states, and a bound with no test is a
 * bound that drifts.
 */
describe("SessionLayout bounds", () => {
  test("depth is bounded, because Pane is recursive and read from a persisted blob", () => {
    expect(MAXIMUM_PANE_DEPTH).toBe(6);
  });

  test("a pane you cannot see is a pane you cannot close", () => {
    expect(FRACTION_RANGE.minimum).toBeGreaterThan(0);
    expect(FRACTION_RANGE.maximum).toBeLessThan(1);
    expect(FRACTION_RANGE.minimum).toBeLessThan(FRACTION_RANGE.maximum);
  });

  test("a session with no terminals has no tabs", () => {
    expect(emptyLayout.tabs).toHaveLength(0);
    expect(emptyLayout.focusedTabIndex).toBe(0);
  });
});
