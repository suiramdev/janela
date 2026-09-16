import { describe, expect, test } from "bun:test";

import {
  emptyLayout,
  singleTerminalLayout,
  type Pane,
  type SessionLayout,
  type TerminalID,
} from "@janela/core";

import {
  resolveLocalLayout,
  tabsInCloseScope,
  withFocusedTab,
  withFocusedTerminal,
  withFraction,
  type LocalLayoutEntry,
  type PanePath,
} from "./local-layout.ts";

const terminalID = (raw: string): TerminalID => raw as TerminalID;

describe("resolveLocalLayout", () => {
  const layout = singleTerminalLayout(terminalID("a"));
  const ids = [terminalID("a")];

  test("a clean mirror layout is adopted by reference", () => {
    const resolved = resolveLocalLayout(undefined, layout, ids);

    expect(resolved.base).toBe(layout);
    expect(resolved.local).toBe(layout);
  });

  test("a layout that violates the algebra is repaired before adoption", () => {
    const broken: SessionLayout = {
      tabs: [
        {
          root: { kind: "terminal", id: terminalID("gone") },
          focusedTerminalID: terminalID("gone"),
        },
      ],
      focusedTabIndex: 0,
    };

    const resolved = resolveLocalLayout(undefined, broken, ids);

    expect(resolved.base).toBe(broken);
    expect(resolved.local).not.toBe(broken);
    expect(resolved.local.tabs).toHaveLength(0);
  });

  test("local edits survive while the mirror layout is the same object", () => {
    const edited = withFocusedTab(
      { tabs: [...layout.tabs, ...layout.tabs], focusedTabIndex: 0 },
      1,
    );

    const entry: LocalLayoutEntry = { base: layout, local: edited };

    expect(resolveLocalLayout(entry, layout, ids)).toBe(entry);
  });

  test("a new mirror layout discards the local edits", () => {
    const entry: LocalLayoutEntry = { base: layout, local: emptyLayout };
    const replacement = singleTerminalLayout(terminalID("a"));

    const resolved = resolveLocalLayout(entry, replacement, ids);

    expect(resolved.local).toBe(replacement);
  });

  test("a daemon-side split keeps the tab this window was looking at", () => {
    const twoTabs: SessionLayout = {
      tabs: [
        { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
        { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
      ],
      focusedTabIndex: 1,
    };

    const entry: LocalLayoutEntry = { base: twoTabs, local: withFocusedTab(twoTabs, 0) };

    const split: SessionLayout = { ...twoTabs, tabs: [...twoTabs.tabs] };
    const resolved = resolveLocalLayout(entry, split, [terminalID("a"), terminalID("b")]);

    expect(resolved.local.focusedTabIndex).toBe(0);
  });

  test("the daemon moving the tab itself is followed: that is what ⌘T is", () => {
    const oneTab: SessionLayout = {
      tabs: [
        { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
      ],
      focusedTabIndex: 0,
    };

    const entry: LocalLayoutEntry = { base: oneTab, local: oneTab };

    const appended: SessionLayout = {
      tabs: [
        ...oneTab.tabs,
        { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
      ],
      focusedTabIndex: 1,
    };

    const resolved = resolveLocalLayout(entry, appended, [terminalID("a"), terminalID("b")]);

    expect(resolved.local.focusedTabIndex).toBe(1);
  });
});

const fractionOf = (pane: Pane): number | undefined =>
  pane.kind === "split" ? pane.fraction : undefined;

describe("withFraction", () => {
  const split: Pane = {
    kind: "split",
    axis: "horizontal",
    fraction: 0.5,
    first: { kind: "terminal", id: terminalID("a") },
    second: {
      kind: "split",
      axis: "vertical",
      fraction: 0.5,
      first: { kind: "terminal", id: terminalID("b") },
      second: { kind: "terminal", id: terminalID("c") },
    },
  };

  const root: PanePath = [];

  test("the empty path addresses the root split", () => {
    expect(fractionOf(withFraction(split, root, 0.3))).toBe(0.3);
  });

  test("a nested path rebuilds only that path", () => {
    const next = withFraction(split, ["second"], 0.25);

    expect(next.kind === "split" && fractionOf(next.second)).toBe(0.25);
    expect(next.kind === "split" && next.first).toBe(split.first);
  });

  test("clamps to the range a pane can still be closed from", () => {
    expect(fractionOf(withFraction(split, root, 0))).toBe(0.05);
    expect(fractionOf(withFraction(split, root, 9))).toBe(0.95);
    expect(fractionOf(withFraction(split, root, Number.NaN))).toBe(0.5);
  });
  test("a path that names nothing leaves the tree alone", () => {
    expect(withFraction(split, ["first"], 0.2)).toBe(split);
    expect(withFraction(split, ["second", "first", "second"], 0.2)).toBe(split);
  });
});

describe("withFocusedTerminal", () => {
  const first = singleTerminalLayout(terminalID("a")).tabs[0];

  const layout: SessionLayout = {
    tabs: [
      first ?? {
        root: { kind: "terminal", id: terminalID("a") },
        focusedTerminalID: terminalID("a"),
      },
      {
        root: {
          kind: "split",
          axis: "horizontal",
          fraction: 0.5,
          first: { kind: "terminal", id: terminalID("b") },
          second: { kind: "terminal", id: terminalID("c") },
        },
        focusedTerminalID: terminalID("b"),
      },
    ],
    focusedTabIndex: 0,
  };

  test("focuses the terminal and the tab holding it", () => {
    const next = withFocusedTerminal(layout, terminalID("c"));

    expect(next.focusedTabIndex).toBe(1);
    expect(next.tabs[1]?.focusedTerminalID).toBe(terminalID("c"));
  });

  test("a terminal that is not in the layout changes nothing", () => {
    expect(withFocusedTerminal(layout, terminalID("zzz"))).toBe(layout);
  });

  test("focusing what is already focused changes nothing", () => {
    expect(withFocusedTerminal(layout, terminalID("a"))).toBe(layout);
  });
});

describe("withFocusedTab", () => {
  const layout: SessionLayout = {
    tabs: [
      { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
      { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
    ],
    focusedTabIndex: 0,
  };

  test("clamps rather than trusts", () => {
    expect(withFocusedTab(layout, 9).focusedTabIndex).toBe(1);
    expect(withFocusedTab(layout, -3).focusedTabIndex).toBe(0);
  });

  test("an empty layout has no tab to focus", () => {
    expect(withFocusedTab(emptyLayout, 1)).toBe(emptyLayout);
  });
});

describe("tabsInCloseScope", () => {
  test("each scope is the run of tabs its label names", () => {
    expect(tabsInCloseScope(4, 1, "this")).toEqual([1]);
    expect(tabsInCloseScope(4, 1, "others")).toEqual([0, 2, 3]);
    expect(tabsInCloseScope(4, 1, "left")).toEqual([0]);
    expect(tabsInCloseScope(4, 1, "right")).toEqual([2, 3]);
    expect(tabsInCloseScope(4, 1, "all")).toEqual([0, 1, 2, 3]);
  });

  test("the ends name nothing on the side they have no tabs on", () => {
    expect(tabsInCloseScope(3, 0, "left")).toEqual([]);
    expect(tabsInCloseScope(3, 2, "right")).toEqual([]);
    expect(tabsInCloseScope(1, 0, "others")).toEqual([]);
  });

  test("a tab the strip no longer has names nothing, and takes no neighbours with it", () => {
    for (const scope of ["this", "others", "left", "right"] as const) {
      expect(tabsInCloseScope(2, 5, scope)).toEqual([]);
      expect(tabsInCloseScope(2, -1, scope)).toEqual([]);
    }

    expect(tabsInCloseScope(2, 5, "all")).toEqual([0, 1]);
  });
});
