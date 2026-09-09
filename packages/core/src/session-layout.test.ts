import { describe, expect, test } from "bun:test";

import type { TerminalID } from "./identifiers.ts";
import type { Axis, LayoutTab, Pane, SessionLayout } from "./session-layout.ts";
import {
  FRACTION_RANGE,
  MAXIMUM_PANE_DEPTH,
  closeTerminal,
  emptyLayout,
  focusNeighbour,
  focusedTab,
  layoutTerminalIDs,
  layoutViolations,
  paneDepth,
  paneTerminalIDs,
  repairLayout,
  resizeSplit,
  singleTerminalLayout,
  splitPane,
} from "./session-layout.ts";

/**
 * `identifier()` is its own seam, and these values never leave the test, so they
 * are branded directly. A layout function must not care what an id looks like.
 */
const id = (raw: string): TerminalID => raw as TerminalID;

const terminal = (raw: string): Pane => ({ kind: "terminal", id: id(raw) });

const split = (first: Pane, second: Pane, axis: Axis = "horizontal", fraction = 0.5): Pane => ({
  kind: "split",
  axis,
  fraction,
  first,
  second,
});

const leftmost = (pane: Pane): TerminalID =>
  pane.kind === "terminal" ? pane.id : leftmost(pane.first);

const tab = (root: Pane, focused?: string): LayoutTab => ({
  root,
  focusedTerminalID: focused === undefined ? leftmost(root) : id(focused),
});

const layout = (tabs: readonly LayoutTab[], focusedTabIndex = 0): SessionLayout => ({
  tabs,
  focusedTabIndex,
});

/**
 * A left-nested chain of the given depth, with `deep` as its left-most (and
 * deepest) terminal. Built iteratively so that a hostile depth — the case
 * `repairLayout` exists for — can be constructed without recursing.
 */
const deepTree = (depth: number): Pane => {
  let pane = terminal("deep");
  for (let level = 1; level < depth; level += 1) pane = split(pane, terminal(`filler-${level}`));
  return pane;
};

/** The ids `deepTree(depth)` names, without walking it. */
const deepTreeIDs = (depth: number): readonly TerminalID[] => {
  const ids = [id("deep")];
  for (let level = 1; level < depth; level += 1) ids.push(id(`filler-${level}`));
  return ids;
};

const tabAt = (value: SessionLayout, index = 0): LayoutTab => {
  const found = value.tabs[index];
  if (found === undefined) throw new Error(`expected a tab at ${index}`);
  return found;
};

const nestedFraction = (value: SessionLayout): number => {
  const { root } = tabAt(value);
  if (root.kind !== "split" || root.second.kind !== "split")
    throw new Error("expected a nested split");
  return root.second.fraction;
};

/**
 * The layout algebra itself is a TODO seam, so these pin the *bounds* it will be
 * written against. They are here from the first commit because they are the rules
 * the layout must obey, and a bound with no test is a bound that drifts.
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

describe("constructing and reading a layout", () => {
  test("a brand-new session is one tab, one terminal, focused, with no title", () => {
    expect(singleTerminalLayout(id("a"))).toStrictEqual({
      tabs: [{ root: { kind: "terminal", id: id("a") }, focusedTerminalID: id("a") }],
      focusedTabIndex: 0,
    });
    expect("title" in tabAt(singleTerminalLayout(id("a")))).toBe(false);
  });

  test("layoutTerminalIDs walks tab then tree, left to right", () => {
    const value = layout([
      tab(split(terminal("a"), split(terminal("b"), terminal("c"), "vertical"))),
      tab(terminal("d")),
    ]);

    expect(layoutTerminalIDs(value)).toEqual(["a", "b", "c", "d"].map(id));
    expect(paneTerminalIDs(tabAt(value).root)).toEqual(["a", "b", "c"].map(id));
  });

  test("a bare terminal is depth 1", () => {
    expect(paneDepth(terminal("a"))).toBe(1);
    expect(paneDepth(split(terminal("a"), terminal("b")))).toBe(2);
    expect(paneDepth(deepTree(MAXIMUM_PANE_DEPTH))).toBe(MAXIMUM_PANE_DEPTH);
  });
});

describe("splitPane", () => {
  test("places the new terminal beside the named one, on the given axis", () => {
    const after = splitPane(singleTerminalLayout(id("a")), id("a"), id("b"), "vertical");

    expect(tabAt(after).root).toEqual(split(terminal("a"), terminal("b"), "vertical", 0.5));
    expect(tabAt(after).focusedTerminalID).toBe(id("b"));
  });

  test("keeps every terminal present exactly once", () => {
    const before = layout([tab(split(terminal("a"), split(terminal("b"), terminal("c"))))]);
    const after = splitPane(before, id("b"), id("d"), "horizontal");

    expect(layoutTerminalIDs(after).toSorted()).toEqual(["a", "b", "c", "d"].map(id));
  });

  test("refuses a split that would exceed the depth bound", () => {
    const atBound = layout([tab(deepTree(MAXIMUM_PANE_DEPTH))]);
    expect(splitPane(atBound, id("deep"), id("new"), "horizontal")).toBe(atBound);

    const belowBound = layout([tab(deepTree(MAXIMUM_PANE_DEPTH - 1))]);
    const after = splitPane(belowBound, id("deep"), id("new"), "horizontal");
    expect(paneDepth(tabAt(after).root)).toBe(MAXIMUM_PANE_DEPTH);
  });

  test("refuses an unknown terminal, and a new id already in the tree", () => {
    const before = layout([tab(split(terminal("a"), terminal("b")))]);

    expect(splitPane(before, id("nobody"), id("c"), "horizontal")).toBe(before);
    expect(splitPane(before, id("a"), id("b"), "horizontal")).toBe(before);
    expect(splitPane(before, id("a"), id("a"), "horizontal")).toBe(before);
  });

  test("splitting a non-focused tab focuses the new terminal there, without switching tab", () => {
    const before = layout([tab(terminal("a")), tab(terminal("b"))], 1);
    const after = splitPane(before, id("a"), id("c"), "horizontal");

    expect(after.focusedTabIndex).toBe(1);
    expect(tabAt(after, 0).focusedTerminalID).toBe(id("c"));
    expect(tabAt(after, 1)).toBe(tabAt(before, 1));
  });
});

describe("closeTerminal", () => {
  test("promotes the sibling into the parent's place, keeping the outer split", () => {
    const before = layout([
      tab(
        split(
          terminal("a"),
          split(terminal("b"), terminal("c"), "vertical", 0.3),
          "horizontal",
          0.7,
        ),
        "a",
      ),
    ]);

    expect(tabAt(closeTerminal(before, id("b"))).root).toEqual(
      split(terminal("a"), terminal("c"), "horizontal", 0.7),
    );
  });

  test("focus follows the promoted sibling when the closed terminal had it", () => {
    const before = layout([tab(split(terminal("a"), split(terminal("b"), terminal("c"))), "a")]);

    expect(tabAt(closeTerminal(before, id("a"))).focusedTerminalID).toBe(id("b"));
  });

  test("focus stays put when some other terminal closed", () => {
    const before = layout([tab(split(terminal("a"), split(terminal("b"), terminal("c"))), "a")]);

    expect(tabAt(closeTerminal(before, id("c"))).focusedTerminalID).toBe(id("a"));
  });

  test("the last terminal in a tab closes the tab, and the focused tab index follows", () => {
    const before = layout([tab(terminal("a")), tab(terminal("b")), tab(terminal("c"))], 2);

    const afterFirst = closeTerminal(before, id("a"));
    expect(afterFirst.tabs).toHaveLength(2);
    expect(afterFirst.focusedTabIndex).toBe(1);
    expect(tabAt(afterFirst, 1)).toBe(tabAt(before, 2));

    const afterFocused = closeTerminal(afterFirst, id("c"));
    expect(afterFocused.tabs).toHaveLength(1);
    expect(afterFocused.focusedTabIndex).toBe(0);
  });

  test("closing the last tab leaves an empty layout — the caller owns the idle terminal", () => {
    expect(closeTerminal(singleTerminalLayout(id("a")), id("a"))).toEqual(emptyLayout);
  });

  test("an absent terminal changes nothing", () => {
    const before = layout([tab(split(terminal("a"), terminal("b")))]);
    expect(closeTerminal(before, id("nobody"))).toBe(before);
  });
});

describe("focusNeighbour", () => {
  const twoTabs = layout([tab(split(terminal("a"), terminal("b")), "a"), tab(terminal("c"))]);

  test("right walks tab-then-tree order and wraps", () => {
    const visited: { id: TerminalID | undefined; tabIndex: number }[] = [];
    let value = twoTabs;
    for (let step = 0; step < 4; step += 1) {
      value = focusNeighbour(value, "right");
      visited.push({ id: focusedTab(value)?.focusedTerminalID, tabIndex: value.focusedTabIndex });
    }

    expect(visited).toEqual([
      { id: id("b"), tabIndex: 0 },
      { id: id("c"), tabIndex: 1 },
      { id: id("a"), tabIndex: 0 },
      { id: id("b"), tabIndex: 0 },
    ]);
  });

  test("left walks backwards, wrapping from the first terminal to the last", () => {
    const after = focusNeighbour(twoTabs, "left");

    expect(after.focusedTabIndex).toBe(1);
    expect(focusedTab(after)?.focusedTerminalID).toBe(id("c"));
  });

  test("up and down are the same traversal as left and right", () => {
    expect(focusedTab(focusNeighbour(twoTabs, "down"))?.focusedTerminalID).toBe(id("b"));
    expect(focusedTab(focusNeighbour(twoTabs, "up"))?.focusedTerminalID).toBe(id("c"));
  });

  test("nothing to move to changes nothing", () => {
    const one = singleTerminalLayout(id("a"));

    expect(focusNeighbour(one, "right")).toBe(one);
    expect(focusNeighbour(emptyLayout, "right")).toBe(emptyLayout);
  });
});

describe("resizeSplit", () => {
  const nested = layout([
    tab(
      split(terminal("a"), split(terminal("b"), terminal("c"), "vertical"), "horizontal", 0.7),
      "a",
    ),
  ]);

  test("sets the fraction of the split holding the terminal, and nothing else", () => {
    const after = resizeSplit(nested, id("b"), 0.3);

    expect(tabAt(after).root).toEqual(
      split(terminal("a"), split(terminal("b"), terminal("c"), "vertical", 0.3), "horizontal", 0.7),
    );
  });

  test("clamps to FRACTION_RANGE, and a non-finite fraction becomes a half", () => {
    expect(nestedFraction(resizeSplit(nested, id("b"), 0.02))).toBe(FRACTION_RANGE.minimum);
    expect(nestedFraction(resizeSplit(nested, id("b"), 0.99))).toBe(FRACTION_RANGE.maximum);
    expect(nestedFraction(resizeSplit(nested, id("b"), Number.NaN))).toBe(0.5);
  });

  test("a terminal with no parent split, and an absent terminal, change nothing", () => {
    const bare = singleTerminalLayout(id("a"));

    expect(resizeSplit(bare, id("a"), 0.3)).toBe(bare);
    expect(resizeSplit(nested, id("nobody"), 0.3)).toBe(nested);
  });
});

const corruptFixtures: readonly {
  readonly layout: SessionLayout;
  readonly existing: readonly TerminalID[];
}[] = [
  { layout: layout([tab(terminal("x")), tab(terminal("a"))], 1), existing: [id("a")] },
  {
    layout: layout([tab(split(terminal("a"), terminal("b")), "ghost")]),
    existing: [id("a"), id("b")],
  },
  {
    layout: layout([tab(split(terminal("a"), terminal("b")), "a"), tab(terminal("a"))]),
    existing: [id("a"), id("b")],
  },
  { layout: layout([tab(deepTree(5000), "deep")]), existing: deepTreeIDs(5000) },
  {
    layout: layout([tab(split(terminal("a"), terminal("b"), "vertical", 4), "a")], 3),
    existing: [id("a"), id("b")],
  },
  { layout: layout([], 4), existing: [] },
  { layout: layout([tab(terminal("x"))], 0), existing: [] },
];

describe("repairLayout", () => {
  test("drops panes naming absent terminals, and the tabs left with none", () => {
    const before = layout(
      [tab(terminal("x")), tab(split(terminal("a"), terminal("b")), "a"), tab(terminal("c"))],
      1,
    );
    const after = repairLayout(before, [id("a"), id("b"), id("c")]);

    expect(after.tabs).toHaveLength(2);
    expect(layoutTerminalIDs(after)).toEqual(["a", "b", "c"].map(id));
    expect(after.focusedTabIndex).toBe(0);
    expect(tabAt(after, 0).focusedTerminalID).toBe(id("a"));
  });

  test("promotes the surviving sibling of a dropped pane", () => {
    const before = layout([tab(split(terminal("gone"), terminal("a")), "a")]);

    expect(tabAt(repairLayout(before, [id("a")])).root).toEqual(terminal("a"));
  });

  test("repairs a focus pointing at nothing to the tab's first terminal", () => {
    const before = layout([tab(split(terminal("a"), terminal("b")), "ghost")]);

    expect(tabAt(repairLayout(before, [id("a"), id("b")])).focusedTerminalID).toBe(id("a"));
  });

  test("keeps the first occurrence of a duplicated terminal, across tabs", () => {
    const before = layout([tab(split(terminal("a"), terminal("b")), "a"), tab(terminal("a"))]);
    const after = repairLayout(before, [id("a"), id("b")]);

    expect(after.tabs).toHaveLength(1);
    expect(layoutTerminalIDs(after)).toEqual(["a", "b"].map(id));
  });

  test("truncates an over-deep tree without recursing into it", () => {
    const before = layout([tab(deepTree(5000), "deep")]);
    const after = repairLayout(before, deepTreeIDs(5000));

    expect(paneDepth(tabAt(after).root)).toBeLessThanOrEqual(MAXIMUM_PANE_DEPTH);
    expect(layoutTerminalIDs(after)).toContain(id("deep"));
  });

  test("clamps every fraction, replacing a non-finite one with a half", () => {
    const before = layout([
      tab(
        split(
          terminal("a"),
          split(terminal("b"), terminal("c"), "vertical", Number.NaN),
          "horizontal",
          1.5,
        ),
        "a",
      ),
    ]);
    const after = repairLayout(before, [id("a"), id("b"), id("c")]);
    const { root } = tabAt(after);

    expect(root.kind === "split" ? root.fraction : undefined).toBe(FRACTION_RANGE.maximum);
    expect(nestedFraction(after)).toBe(0.5);
  });

  test("clamps focusedTabIndex to a real tab", () => {
    const two = [tab(terminal("a")), tab(terminal("b"))];
    const existing = [id("a"), id("b")];

    expect(repairLayout(layout(two, -1), existing).focusedTabIndex).toBe(0);
    expect(repairLayout(layout(two, 99), existing).focusedTabIndex).toBe(1);
    expect(repairLayout(layout(two, Number.NaN), existing).focusedTabIndex).toBe(0);
    expect(repairLayout(layout([], 4), existing).focusedTabIndex).toBe(0);
  });

  test("a valid layout is returned as it was", () => {
    const valid = layout(
      [tab(split(terminal("a"), terminal("b"), "vertical", 0.3), "b"), tab(terminal("c"))],
      1,
    );

    expect(repairLayout(valid, [id("a"), id("b"), id("c")])).toEqual(valid);
  });

  test("leaves no violation behind, for any corruption", () => {
    for (const corrupt of corruptFixtures) {
      const repaired = repairLayout(corrupt.layout, corrupt.existing);
      expect(layoutViolations(repaired, corrupt.existing)).toEqual([]);
    }
  });
});

describe("layoutViolations", () => {
  test("an intact layout has none", () => {
    const valid = layout(
      [tab(split(terminal("a"), terminal("b"), "vertical", 0.3), "b"), tab(terminal("c"))],
      1,
    );

    expect(layoutViolations(valid, [id("a"), id("b"), id("c")])).toEqual([]);
  });

  test("reports one reason per defect, so the decoder has something to log", () => {
    const corrupt = layout(
      [
        tab(deepTree(8), "deep"),
        tab(split(terminal("a"), split(terminal("ghost"), terminal("a"), "vertical", 2)), "nobody"),
      ],
      7,
    );

    const reasons = layoutViolations(corrupt, [id("a"), ...deepTreeIDs(8)]);

    expect(reasons).toHaveLength(6);
    expect(reasons.some((reason) => reason.includes(`deeper than ${MAXIMUM_PANE_DEPTH}`))).toBe(
      true,
    );
    expect(reasons.some((reason) => reason.includes("ghost"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("more than once"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("focusedTabIndex 7"))).toBe(true);
  });
});
