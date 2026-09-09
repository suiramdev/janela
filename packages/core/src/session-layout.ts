import type { TerminalID } from "./identifiers.ts";

/**
 * How a session arranges its terminals: tabs, each holding a tree of splits.
 *
 * This is per-session *state*, persisted with the session — not a saved object
 * the user names and manages. "The layout is wherever you left it" only works if
 * where you left it is written down.
 */
export interface SessionLayout {
  /**
   * Ordered, as the user arranged them. Never empty in a session that has
   * terminals; a session with no terminals has no tabs.
   */
  readonly tabs: readonly LayoutTab[];

  /** Index into `tabs`. Clamped on decode rather than trusted. */
  readonly focusedTabIndex: number;
}

/** One tab: a title, a tree of panes, and which pane has focus. */
export interface LayoutTab {
  /**
   * Absent means "derive from the focused terminal", which is what users expect
   * until they rename a tab explicitly.
   */
  readonly title?: string;

  readonly root: Pane;

  /**
   * Must name a terminal present in `root`. Repaired rather than trusted on load:
   * a focus pointing at nothing falls back to the first terminal.
   */
  readonly focusedTerminalID: TerminalID;
}

/**
 * A node in a tab's split tree: either a terminal, or a division of two panes.
 *
 * Binary rather than n-ary because every split operation the UI offers is binary,
 * and because promoting a sibling when a pane closes is trivial in a binary tree
 * and fiddly in an n-ary one.
 */
export type Pane =
  | { readonly kind: "terminal"; readonly id: TerminalID }
  | {
      readonly kind: "split";
      readonly axis: Axis;
      readonly fraction: number;
      readonly first: Pane;
      readonly second: Pane;
    };

/**
 * Which way a split divides its two panes.
 *
 * `horizontal` — panes side by side; the divider is vertical.
 * `vertical` — panes stacked; the divider is horizontal.
 */
export type Axis = "horizontal" | "vertical";

/**
 * Maximum nesting depth of a split tree.
 *
 * This is not a style preference. `Pane` is recursive and decoded from a persisted
 * blob, so an unbounded depth is a decoding hazard; and past about four levels a
 * pane is too small to read anyway. Deeper trees are a misclick, not a workflow.
 */
export const MAXIMUM_PANE_DEPTH = 6;

/**
 * Fractions are clamped to this range, because a pane you cannot see is a pane
 * you cannot close.
 */
export const FRACTION_RANGE = { minimum: 0.05, maximum: 0.95 } as const;

/** An empty layout. A session with no terminals has no tabs. */
export const emptyLayout: SessionLayout = { tabs: [], focusedTabIndex: 0 };

/** The layout for a brand-new session: one tab, one terminal, no splits. */
export function singleTerminalLayout(id: TerminalID): SessionLayout {
  return {
    tabs: [{ root: { kind: "terminal", id }, focusedTerminalID: id }],
    focusedTabIndex: 0,
  };
}

export function focusedTab(layout: SessionLayout): LayoutTab | undefined {
  return layout.tabs[layout.focusedTabIndex];
}

/** Every terminal referenced anywhere in the layout, in tab then tree order. */
export function layoutTerminalIDs(layout: SessionLayout): readonly TerminalID[] {
  const ids: TerminalID[] = [];
  for (const tab of layout.tabs) collectTerminalIDs(tab.root, ids);
  return ids;
}

/** Every terminal in this subtree, left to right. */
export function paneTerminalIDs(pane: Pane): readonly TerminalID[] {
  const ids: TerminalID[] = [];
  collectTerminalIDs(pane, ids);
  return ids;
}

/**
 * Nesting depth, where a bare terminal is 1.
 *
 * Recursive, so it is for trees already known to be bounded — one this module
 * just built, or one that has been through `repairLayout`. A decoder repairs
 * first and measures afterwards; `layoutViolations` reports a depth breach
 * without ever descending into the subtree that caused it.
 */
export function paneDepth(pane: Pane): number {
  if (pane.kind === "terminal") return 1;
  return 1 + Math.max(paneDepth(pane.first), paneDepth(pane.second));
}

// The invariants this algebra maintains are the four layout rules quoted in the
// type doc comments above.

/** One rule for construction, resize and repair. A non-finite fraction is a half. */
function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0.5;
  return Math.min(FRACTION_RANGE.maximum, Math.max(FRACTION_RANGE.minimum, fraction));
}

function collectTerminalIDs(pane: Pane, into: TerminalID[]): void {
  if (pane.kind === "terminal") {
    into.push(pane.id);
    return;
  }
  collectTerminalIDs(pane.first, into);
  collectTerminalIDs(pane.second, into);
}

function containsTerminal(pane: Pane, id: TerminalID): boolean {
  if (pane.kind === "terminal") return pane.id === id;
  return containsTerminal(pane.first, id) || containsTerminal(pane.second, id);
}

/**
 * The left-most terminal, found iteratively: this one runs during repair, on a
 * tree that arrived from a persisted blob and may be absurdly deep.
 */
function firstTerminalID(pane: Pane): TerminalID {
  let node = pane;
  while (node.kind === "split") node = node.first;
  return node.id;
}

/** The index of the first tab whose tree names `id`, or -1. */
function tabIndexContaining(layout: SessionLayout, id: TerminalID): number {
  return layout.tabs.findIndex((tab) => containsTerminal(tab.root, id));
}

/** Rebuilds the path to `id`, reusing every untouched subtree by reference. */
function replaceTerminal(pane: Pane, id: TerminalID, replacement: Pane): Pane {
  if (pane.kind === "terminal") return pane.id === id ? replacement : pane;

  const first = replaceTerminal(pane.first, id, replacement);
  const second = first === pane.first ? replaceTerminal(pane.second, id, replacement) : pane.second;
  if (first === pane.first && second === pane.second) return pane;
  return { ...pane, first, second };
}

/** The other child of the split holding `id`; absent when `id` is a root or missing. */
function siblingOf(pane: Pane, id: TerminalID): Pane | undefined {
  if (pane.kind === "terminal") return undefined;
  if (pane.first.kind === "terminal" && pane.first.id === id) return pane.second;
  if (pane.second.kind === "terminal" && pane.second.id === id) return pane.first;
  return siblingOf(pane.first, id) ?? siblingOf(pane.second, id);
}

/** Removes `id`, promoting its sibling. Absent when `pane` *is* that terminal. */
function removeTerminal(pane: Pane, id: TerminalID): Pane | undefined {
  if (pane.kind === "terminal") return pane.id === id ? undefined : pane;

  if (containsTerminal(pane.first, id)) {
    const first = removeTerminal(pane.first, id);
    return first === undefined ? pane.second : { ...pane, first };
  }
  if (containsTerminal(pane.second, id)) {
    const second = removeTerminal(pane.second, id);
    return second === undefined ? pane.first : { ...pane, second };
  }
  return pane;
}

/** Sets `fraction` on the split whose direct child is the pane holding `id`. */
function resizeParent(pane: Pane, id: TerminalID, fraction: number): Pane {
  if (pane.kind === "terminal") return pane;

  const holdsIt =
    (pane.first.kind === "terminal" && pane.first.id === id) ||
    (pane.second.kind === "terminal" && pane.second.id === id);
  if (holdsIt) return { ...pane, fraction };

  const first = resizeParent(pane.first, id, fraction);
  const second = first === pane.first ? resizeParent(pane.second, id, fraction) : pane.second;
  if (first === pane.first && second === pane.second) return pane;
  return { ...pane, first, second };
}

/**
 * Whether this tree is deeper than the bound.
 *
 * Iterative, and it never pushes the children of a node already at the bound, so
 * it visits at most 2^MAXIMUM_PANE_DEPTH nodes however deep the input is. That is
 * the whole point: this runs on the untrusted blob, before anything recurses.
 */
function exceedsDepth(pane: Pane): boolean {
  const stack: { readonly pane: Pane; readonly level: number }[] = [{ pane, level: 1 }];
  for (;;) {
    const entry = stack.pop();
    if (entry === undefined) return false;
    if (entry.pane.kind !== "split") continue;
    if (entry.level >= MAXIMUM_PANE_DEPTH) return true;
    stack.push({ pane: entry.pane.first, level: entry.level + 1 });
    stack.push({ pane: entry.pane.second, level: entry.level + 1 });
  }
}

/**
 * Collapses whatever sits below the bound to its left-most terminal.
 *
 * Recursion here is bounded by MAXIMUM_PANE_DEPTH frames by construction, which is
 * why every other repair step may be recursive: they all run on the result. The
 * terminals lost from the tree still exist in `session.terminals`, because
 * decoding truncates rather than fails.
 */
function truncateDepth(pane: Pane, level: number): Pane {
  if (pane.kind === "terminal") return pane;
  if (level >= MAXIMUM_PANE_DEPTH) return { kind: "terminal", id: firstTerminalID(pane) };

  const first = truncateDepth(pane.first, level + 1);
  const second = truncateDepth(pane.second, level + 1);
  if (first === pane.first && second === pane.second) return pane;
  return { ...pane, first, second };
}

/**
 * Drops terminals that no longer exist and repeat occurrences of ones that do,
 * promoting the surviving sibling and clamping the fractions on the way out.
 *
 * `seen` is shared across every tab, so "exactly once" holds layout-wide and the
 * first occurrence in tab-then-tree order is the one that survives.
 */
function dropAbsent(
  pane: Pane,
  existing: ReadonlySet<TerminalID>,
  seen: Set<TerminalID>,
): Pane | undefined {
  if (pane.kind === "terminal") {
    if (!existing.has(pane.id) || seen.has(pane.id)) return undefined;
    seen.add(pane.id);
    return pane;
  }

  const first = dropAbsent(pane.first, existing, seen);
  const second = dropAbsent(pane.second, existing, seen);
  if (first === undefined) return second;
  if (second === undefined) return first;

  const fraction = clampFraction(pane.fraction);
  if (first === pane.first && second === pane.second && fraction === pane.fraction) return pane;
  return { ...pane, first, second, fraction };
}

/**
 * Splits the pane holding `terminal`, placing `newTerminal` beside it.
 *
 * The existing terminal keeps its place (left, or top) and the new one takes the
 * other half of an even split, then takes focus within its own tab — splitting a
 * pane is not switching tab, so `focusedTabIndex` does not move.
 *
 * - Returns the layout unchanged when `terminal` is not in the tree.
 * - Returns it unchanged when `newTerminal` is already in the tree, or is
 *   `terminal`: a terminal appears in a layout exactly once.
 * - Refuses (returns unchanged) when the split would exceed `MAXIMUM_PANE_DEPTH`.
 */
export function splitPane(
  layout: SessionLayout,
  terminal: TerminalID,
  newTerminal: TerminalID,
  axis: Axis,
): SessionLayout {
  if (terminal === newTerminal) return layout;
  if (tabIndexContaining(layout, newTerminal) !== -1) return layout;

  const index = tabIndexContaining(layout, terminal);
  const tab = layout.tabs[index];
  if (tab === undefined) return layout;

  const root = replaceTerminal(tab.root, terminal, {
    kind: "split",
    axis,
    fraction: 0.5,
    first: { kind: "terminal", id: terminal },
    second: { kind: "terminal", id: newTerminal },
  });
  if (paneDepth(root) > MAXIMUM_PANE_DEPTH) return layout;

  const tabs = layout.tabs.map((existing, at) =>
    at === index ? { ...tab, root, focusedTerminalID: newTerminal } : existing,
  );
  return { ...layout, tabs };
}

/**
 * Removes a terminal, promoting its sibling into the space.
 *
 * Closing the last terminal in a tab closes the tab. Closing the last tab returns
 * an empty layout — the caller is responsible for the "leaves one idle terminal"
 * rule, because creating a terminal is not something a pure function may do.
 *
 * When the closed terminal held focus, focus moves to the first terminal of the
 * promoted sibling; when a tab closes, `focusedTabIndex` follows the tab the user
 * was looking at.
 */
export function closeTerminal(layout: SessionLayout, terminal: TerminalID): SessionLayout {
  const index = tabIndexContaining(layout, terminal);
  const tab = layout.tabs[index];
  if (tab === undefined) return layout;

  const root = removeTerminal(tab.root, terminal);

  if (root === undefined) {
    const tabs = layout.tabs.filter((_, at) => at !== index);
    if (tabs.length === 0) return emptyLayout;

    let focusedTabIndex = layout.focusedTabIndex;
    if (focusedTabIndex > index) focusedTabIndex -= 1;
    else if (focusedTabIndex === index) focusedTabIndex = Math.min(index, tabs.length - 1);
    return { tabs, focusedTabIndex };
  }

  // `root` survived, so the terminal had a parent split, so it had a sibling.
  const sibling = siblingOf(tab.root, terminal);
  if (sibling === undefined) return layout;

  const focusedTerminalID =
    tab.focusedTerminalID === terminal ? firstTerminalID(sibling) : tab.focusedTerminalID;
  const tabs = layout.tabs.map((existing, at) =>
    at === index ? { ...tab, root, focusedTerminalID } : existing,
  );
  return { ...layout, tabs };
}

/**
 * Moves focus to the next (`right`/`down`) or previous (`left`/`up`) terminal in
 * tab-then-tree order — the order `layoutTerminalIDs` returns — wrapping from the
 * last terminal of the last tab to the first terminal of the first tab and back.
 * `focusedTabIndex` follows across a tab boundary; the tabs left behind keep their
 * own focus.
 *
 * Returns the layout unchanged when there is one terminal or none, or when the
 * current focus names nothing in the tree — `repairLayout` owns that.
 */
export function focusNeighbour(
  layout: SessionLayout,
  direction: "left" | "right" | "up" | "down",
): SessionLayout {
  const focused = focusedTab(layout);
  if (focused === undefined) return layout;

  const entries: { readonly tabIndex: number; readonly id: TerminalID }[] = [];
  for (const [tabIndex, tab] of layout.tabs.entries()) {
    for (const id of paneTerminalIDs(tab.root)) entries.push({ tabIndex, id });
  }
  if (entries.length < 2) return layout;

  const current = entries.findIndex(
    (entry) => entry.tabIndex === layout.focusedTabIndex && entry.id === focused.focusedTerminalID,
  );
  if (current === -1) return layout;

  const step = direction === "right" || direction === "down" ? 1 : -1;
  const next = entries[(current + step + entries.length) % entries.length];
  if (next === undefined) return layout;

  const tabs = layout.tabs.map((tab, at) =>
    at === next.tabIndex ? { ...tab, focusedTerminalID: next.id } : tab,
  );
  return { tabs, focusedTabIndex: next.tabIndex };
}

/**
 * Sets the fraction of the split whose direct child is the pane holding
 * `terminal`, clamped to `FRACTION_RANGE` — a non-finite fraction becomes a half.
 *
 * Unchanged when `terminal` is absent, or is a tab's whole root: a root has no
 * parent split to resize.
 */
export function resizeSplit(
  layout: SessionLayout,
  terminal: TerminalID,
  fraction: number,
): SessionLayout {
  const index = tabIndexContaining(layout, terminal);
  const tab = layout.tabs[index];
  if (tab === undefined || tab.root.kind === "terminal") return layout;

  const root = resizeParent(tab.root, terminal, clampFraction(fraction));
  if (root === tab.root) return layout;

  const tabs = layout.tabs.map((existing, at) => (at === index ? { ...tab, root } : existing));
  return { ...layout, tabs };
}

/**
 * The reasons a persisted layout is not the layout `repairLayout` would produce,
 * empty when it is fine.
 *
 * Pure and bounded on hostile input, and what `@janela/db` logs on load — it logs
 * shapes (a tab index, a terminal id, a count), never content. A depth breach is
 * reported before anything inside the over-deep subtree, because that subtree is
 * exactly what is not walked.
 */
export function layoutViolations(
  layout: SessionLayout,
  existing: readonly TerminalID[],
): readonly string[] {
  const allowed = new Set(existing);
  const seen = new Set<TerminalID>();
  const reasons: string[] = [];

  for (const [index, tab] of layout.tabs.entries()) {
    if (exceedsDepth(tab.root)) {
      reasons.push(`tab ${index}: split tree deeper than ${MAXIMUM_PANE_DEPTH}`);
    }

    const root = truncateDepth(tab.root, 1);
    collectPaneViolations(root, index, allowed, seen, reasons);
    if (!containsTerminal(root, tab.focusedTerminalID)) {
      reasons.push(`tab ${index}: focus names absent terminal ${tab.focusedTerminalID}`);
    }
  }

  const last = Math.max(layout.tabs.length - 1, 0);
  const focused = layout.focusedTabIndex;
  const focusIsValid =
    layout.tabs.length === 0
      ? focused === 0
      : Number.isInteger(focused) && focused >= 0 && focused <= last;
  if (!focusIsValid) reasons.push(`focusedTabIndex ${focused} outside 0..${last}`);

  return reasons;
}

function collectPaneViolations(
  pane: Pane,
  tabIndex: number,
  existing: ReadonlySet<TerminalID>,
  seen: Set<TerminalID>,
  into: string[],
): void {
  if (pane.kind === "terminal") {
    if (!existing.has(pane.id)) into.push(`tab ${tabIndex}: pane names absent terminal ${pane.id}`);
    else if (seen.has(pane.id))
      into.push(`tab ${tabIndex}: terminal ${pane.id} appears more than once`);
    else seen.add(pane.id);
    return;
  }

  if (clampFraction(pane.fraction) !== pane.fraction) {
    into.push(
      `tab ${tabIndex}: fraction ${pane.fraction} outside ${FRACTION_RANGE.minimum}..${FRACTION_RANGE.maximum}`,
    );
  }
  collectPaneViolations(pane.first, tabIndex, existing, seen, into);
  collectPaneViolations(pane.second, tabIndex, existing, seen, into);
}

/**
 * Drops panes naming terminals that no longer exist, clamps every fraction, and
 * repairs a focus pointing at nothing.
 *
 * Called on every load. A corrupt layout must degrade, never throw: the
 * alternative is a session the user cannot open. Truncation runs first, so no
 * later step recurses past `MAXIMUM_PANE_DEPTH` on a hostile tree.
 */
export function repairLayout(
  layout: SessionLayout,
  existing: readonly TerminalID[],
): SessionLayout {
  const allowed = new Set(existing);
  const seen = new Set<TerminalID>();
  const tabs: LayoutTab[] = [];

  const focused = Number.isInteger(layout.focusedTabIndex) ? layout.focusedTabIndex : 0;
  let survivorsBefore = 0;
  let focusedSurvivor: number | undefined;

  for (const [index, tab] of layout.tabs.entries()) {
    const root = dropAbsent(truncateDepth(tab.root, 1), allowed, seen);
    if (root === undefined) continue;

    const focusedTerminalID = containsTerminal(root, tab.focusedTerminalID)
      ? tab.focusedTerminalID
      : firstTerminalID(root);

    if (index === focused) focusedSurvivor = tabs.length;
    else if (index < focused) survivorsBefore += 1;

    tabs.push({ ...tab, root, focusedTerminalID });
  }

  // Keep the user on the tab they were looking at when an earlier one was
  // dropped, rather than blindly clamping the number they had.
  let focusedTabIndex = 0;
  if (tabs.length > 0) {
    focusedTabIndex = focusedSurvivor ?? Math.max(0, Math.min(survivorsBefore, tabs.length - 1));
  }

  return { tabs, focusedTabIndex };
}
