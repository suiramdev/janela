import type { TerminalID } from "./identifiers.ts";

/**
 * How a session arranges its terminals: tabs, each holding a tree of splits.
 *
 * This is per-session *state*, persisted with the session — not a saved object
 * the user names and manages. "The layout is wherever you left it" only works if
 * where you left it is written down. See docs/decisions/0010-terminal-layout.md.
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
  void id;
  throw new Error(`not implemented: singleTerminalLayout`);
}

export function focusedTab(layout: SessionLayout): LayoutTab | undefined {
  void layout;
  throw new Error(`not implemented: focusedTab`);
}

/** Every terminal referenced anywhere in the layout, in tab then tree order. */
export function layoutTerminalIDs(layout: SessionLayout): readonly TerminalID[] {
  void layout;
  throw new Error(`not implemented: layoutTerminalIDs`);
}

/** Every terminal in this subtree, left to right. */
export function paneTerminalIDs(pane: Pane): readonly TerminalID[] {
  void pane;
  throw new Error(`not implemented: paneTerminalIDs`);
}

/** Nesting depth, where a bare terminal is 1. */
export function paneDepth(pane: Pane): number {
  void pane;
  throw new Error(`not implemented: paneDepth`);
}

// TODO: The layout algebra — `splitPane`, `closeTerminal` with sibling
// promotion, and focus traversal. All pure, all cheap to test, and every rule is
// written down in docs/decisions/0010-terminal-layout.md:
//
//   - Every `TerminalID` in the tree exists in `session.terminals`, exactly once.
//     A layout referencing a dead terminal is a corrupt layout; loading repairs
//     it by dropping the pane rather than by failing.
//   - `fraction` is clamped to FRACTION_RANGE on every construction and on decode.
//   - Depth is bounded at MAXIMUM_PANE_DEPTH; a split that would exceed it is
//     refused rather than truncated.
//   - Closing a terminal collapses its split, promoting the sibling. Closing the
//     last terminal in a tab closes the tab; closing the last tab leaves the
//     session with one idle terminal, not zero.
//
// This was one of the few parts of the previous scaffold with a real body, and its
// tests are the model for the rest of the suite: pure values in, pure values out,
// no fixtures. See docs/MIGRATION_MAP.md.

/**
 * Splits the pane holding `terminal`, placing `newTerminal` beside it.
 *
 * - Returns the layout unchanged when `terminal` is not in the tree.
 * - Refuses (returns unchanged) when the split would exceed `MAXIMUM_PANE_DEPTH`.
 */
export function splitPane(
  layout: SessionLayout,
  terminal: TerminalID,
  newTerminal: TerminalID,
  axis: Axis,
): SessionLayout {
  void layout;
  void terminal;
  void newTerminal;
  void axis;
  throw new Error(`not implemented: splitPane`);
}

/**
 * Removes a terminal, promoting its sibling into the space.
 *
 * Closing the last terminal in a tab closes the tab. Closing the last tab returns
 * an empty layout — the caller is responsible for the "leaves one idle terminal"
 * rule, because creating a terminal is not something a pure function may do.
 */
export function closeTerminal(layout: SessionLayout, terminal: TerminalID): SessionLayout {
  void layout;
  void terminal;
  throw new Error(`not implemented: closeTerminal`);
}

/** Moves focus within the focused tab, in a direction. Returns unchanged at an edge. */
export function focusNeighbour(
  layout: SessionLayout,
  direction: "left" | "right" | "up" | "down",
): SessionLayout {
  void layout;
  void direction;
  throw new Error(`not implemented: focusNeighbour`);
}

/** Sets a split's fraction, clamped. */
export function resizeSplit(
  layout: SessionLayout,
  terminal: TerminalID,
  fraction: number,
): SessionLayout {
  void layout;
  void terminal;
  void fraction;
  throw new Error(`not implemented: resizeSplit`);
}

/**
 * Drops panes naming terminals that no longer exist, clamps every fraction, and
 * repairs a focus pointing at nothing.
 *
 * Called on every load. A corrupt layout must degrade, never throw: the
 * alternative is a session the user cannot open.
 */
export function repairLayout(
  layout: SessionLayout,
  existing: readonly TerminalID[],
): SessionLayout {
  void layout;
  void existing;
  throw new Error(`not implemented: repairLayout`);
}
