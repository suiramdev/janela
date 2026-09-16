import {
  layoutViolations,
  paneTerminalIDs,
  repairLayout,
  FRACTION_RANGE,
  type Pane,
  type SessionLayout,
  type TerminalID,
} from "@janela/core";

/**
 * Local edits to a session's on-screen layout.
 *
 * Splitter fractions, pane focus and tab selection are **local view state**, seeded
 * from the mirror and re-adopted whenever the mirror's layout changes. Splits and
 * pane closes are not: those are the daemon's, and arrive back through the mirror.
 *
 * These functions are pure so the store that holds the state (`view-state.ts`) has
 * nothing to test beyond the bookkeeping, and so a view can reason about a layout
 * without owning one.
 */

/** A route from a tab's root to one of its splits. Empty addresses the root. */
export type PanePath = readonly ("first" | "second")[];

/**
 * A session's local layout, and the mirror layout it was derived from.
 *
 * `base` is held by reference on purpose: it is how "the daemon changed the layout"
 * is told apart from "the user dragged a divider", with no deep comparison and no
 * revision counter on the wire.
 */
export interface LocalLayoutEntry {
  readonly base: SessionLayout;
  readonly local: SessionLayout;
}

/**
 * The layout to render.
 *
 * Adopts the mirror's layout — repaired first when it violates the algebra's
 * invariants — whenever `base` no longer matches it by reference; otherwise keeps
 * the local edits. Validation and repair are `@janela/core`'s (`layoutViolations`,
 * `repairLayout`): a view that invented its own would be a second opinion about an
 * invariant.
 *
 * ## Which tab survives an adoption
 *
 * Splits and pane closes are daemon-persisted (protocol v4), so a split arrives
 * here as a whole new layout — and adopting all of it would move the user off the
 * tab they were looking at, because the stored `focusedTabIndex` is whatever the
 * last tab creation left behind. Tab selection is this window's, so it survives.
 *
 * The exception is the daemon moving it *itself*: `createTerminal` without a
 * placement appends a focused tab, and following it is the whole point of ⌘T. The
 * two are told apart by whether `focusedTabIndex` changed since the layout this
 * entry was derived from.
 */
export function resolveLocalLayout(
  entry: LocalLayoutEntry | undefined,
  mirror: SessionLayout,
  existingTerminalIDs: readonly TerminalID[],
): LocalLayoutEntry {
  if (entry !== undefined && entry.base === mirror) return entry;
  const violations = layoutViolations(mirror, existingTerminalIDs);
  const adopted = violations.length === 0 ? mirror : repairLayout(mirror, existingTerminalIDs);

  if (entry === undefined || entry.base.focusedTabIndex !== mirror.focusedTabIndex) {
    return { base: mirror, local: adopted };
  }
  return { base: mirror, local: withFocusedTab(adopted, entry.local.focusedTabIndex) };
}

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  return Math.min(FRACTION_RANGE.maximum, Math.max(FRACTION_RANGE.minimum, fraction));
}

/**
 * Sets the fraction of the split at `path`, rebuilding only that path.
 *
 * `resizeSplit` in `@janela/core` addresses a split by a terminal it contains,
 * which cannot name the divider of an outer split whose children are both splits.
 * A divider knows its own path, so it says so.
 */
export function withFraction(root: Pane, path: PanePath, fraction: number): Pane {
  const step = path[0];
  if (step === undefined) {
    return root.kind === "split" ? { ...root, fraction: clampFraction(fraction) } : root;
  }
  if (root.kind !== "split") return root;
  const child = root[step];
  const replaced = withFraction(child, path.slice(1), fraction);
  if (replaced === child) return root;
  return step === "first" ? { ...root, first: replaced } : { ...root, second: replaced };
}

/** The same, for the layout's focused tab. */
export function withSplitFraction(
  layout: SessionLayout,
  path: PanePath,
  fraction: number,
): SessionLayout {
  const index = layout.focusedTabIndex;
  const tab = layout.tabs[index];
  if (tab === undefined) return layout;
  const root = withFraction(tab.root, path, fraction);
  if (root === tab.root) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((existing, at) => (at === index ? { ...existing, root } : existing)),
  };
}

/** Focuses the terminal and the tab holding it. Unchanged when it is not there. */
export function withFocusedTerminal(layout: SessionLayout, id: TerminalID): SessionLayout {
  const index = layout.tabs.findIndex((tab) => paneTerminalIDs(tab.root).includes(id));
  const tab = index === -1 ? undefined : layout.tabs[index];
  if (tab === undefined) return layout;
  if (layout.focusedTabIndex === index && tab.focusedTerminalID === id) return layout;
  return {
    tabs: layout.tabs.map((existing, at) =>
      at === index ? { ...existing, focusedTerminalID: id } : existing,
    ),
    focusedTabIndex: index,
  };
}

/** Focuses a tab by index, clamped rather than trusted. */
export function withFocusedTab(layout: SessionLayout, index: number): SessionLayout {
  if (layout.tabs.length === 0) return layout;
  const clamped = Math.min(layout.tabs.length - 1, Math.max(0, Math.trunc(index)));
  return clamped === layout.focusedTabIndex ? layout : { ...layout, focusedTabIndex: clamped };
}

/**
 * Which tabs a close names, relative to the one the menu was opened on.
 *
 * `"this"` is the tab's own ✕; the other four are the strip's context menu. They
 * differ only in which run of indices they mean, so the arithmetic is one
 * function with a test rather than four handlers each deciding what "to the
 * left" is.
 *
 * Indices come back in strip order, and one the layout does not have names
 * nothing: the daemon owns the layout, so a terminal exiting anywhere can
 * renumber the strip under a menu that is already open.
 */
export type TabCloseScope = "this" | "others" | "left" | "right" | "all";

const NO_TABS: readonly number[] = [];

export function tabsInCloseScope(
  count: number,
  index: number,
  scope: TabCloseScope,
): readonly number[] {
  const every = Array.from({ length: Math.max(0, count) }, (_, at) => at);
  // "All" is the one scope that does not read the tab it was opened on, so it
  // still means every tab when that tab has just gone.
  if (scope === "all") return every;
  if (index < 0 || index >= count) return NO_TABS;
  switch (scope) {
    case "this":
      return [index];
    case "others":
      return every.filter((at) => at !== index);
    case "left":
      return every.slice(0, index);
    case "right":
      return every.slice(index + 1);
  }
}
