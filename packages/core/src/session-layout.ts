import type { TerminalID } from "./identifiers.ts";

export interface SessionLayout {
  readonly tabs: readonly LayoutTab[];
  readonly focusedTabIndex: number;
}

export interface LayoutTab {
  readonly title?: string;
  readonly root: Pane;
  readonly focusedTerminalID: TerminalID;
}

export type Pane =
  | { readonly kind: "terminal"; readonly id: TerminalID }
  | {
      readonly kind: "split";
      readonly axis: Axis;
      readonly fraction: number;
      readonly first: Pane;
      readonly second: Pane;
    };

export type Axis = "horizontal" | "vertical";

export const MAXIMUM_PANE_DEPTH = 6;

export const FRACTION_RANGE = { minimum: 0.05, maximum: 0.95 } as const;

export const emptyLayout: SessionLayout = { tabs: [], focusedTabIndex: 0 };

export function singleTerminalLayout(id: TerminalID): SessionLayout {
  return {
    tabs: [{ root: { kind: "terminal", id }, focusedTerminalID: id }],
    focusedTabIndex: 0,
  };
}

export function focusedTab(layout: SessionLayout): LayoutTab | undefined {
  return layout.tabs[layout.focusedTabIndex];
}

export function layoutTerminalIDs(layout: SessionLayout): readonly TerminalID[] {
  const ids: TerminalID[] = [];

  for (const tab of layout.tabs) collectTerminalIDs(tab.root, ids);

  return ids;
}

export function paneTerminalIDs(pane: Pane): readonly TerminalID[] {
  const ids: TerminalID[] = [];

  collectTerminalIDs(pane, ids);

  return ids;
}

export function paneDepth(pane: Pane): number {
  if (pane.kind === "terminal") return 1;

  return 1 + Math.max(paneDepth(pane.first), paneDepth(pane.second));
}

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

function firstTerminalID(pane: Pane): TerminalID {
  let node = pane;

  while (node.kind === "split") node = node.first;

  return node.id;
}

function tabIndexContaining(layout: SessionLayout, id: TerminalID): number {
  return layout.tabs.findIndex((tab) => containsTerminal(tab.root, id));
}

function replaceTerminal(pane: Pane, id: TerminalID, replacement: Pane): Pane {
  if (pane.kind === "terminal") return pane.id === id ? replacement : pane;

  const first = replaceTerminal(pane.first, id, replacement);
  const second = first === pane.first ? replaceTerminal(pane.second, id, replacement) : pane.second;

  if (first === pane.first && second === pane.second) return pane;

  return { ...pane, first, second };
}

function siblingOf(pane: Pane, id: TerminalID): Pane | undefined {
  if (pane.kind === "terminal") return undefined;

  if (pane.first.kind === "terminal" && pane.first.id === id) return pane.second;

  if (pane.second.kind === "terminal" && pane.second.id === id) return pane.first;

  return siblingOf(pane.first, id) ?? siblingOf(pane.second, id);
}

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

function truncateDepth(pane: Pane, level: number): Pane {
  if (pane.kind === "terminal") return pane;

  if (level >= MAXIMUM_PANE_DEPTH) return { kind: "terminal", id: firstTerminalID(pane) };

  const first = truncateDepth(pane.first, level + 1);
  const second = truncateDepth(pane.second, level + 1);

  if (first === pane.first && second === pane.second) return pane;

  return { ...pane, first, second };
}

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

  const sibling = siblingOf(tab.root, terminal);

  if (sibling === undefined) return layout;

  const focusedTerminalID =
    tab.focusedTerminalID === terminal ? firstTerminalID(sibling) : tab.focusedTerminalID;
  const tabs = layout.tabs.map((existing, at) =>
    at === index ? { ...tab, root, focusedTerminalID } : existing,
  );

  return { ...layout, tabs };
}

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

export function moveTab(layout: SessionLayout, from: number, to: number): SessionLayout {
  const last = layout.tabs.length - 1;
  const inRange = (index: number): boolean =>
    Number.isInteger(index) && index >= 0 && index <= last;

  if (from === to || !inRange(from) || !inRange(to)) return layout;

  const tabs = [...layout.tabs];
  const [moved] = tabs.splice(from, 1);

  if (moved === undefined) return layout;

  tabs.splice(to, 0, moved);

  let focusedTabIndex = layout.focusedTabIndex;

  if (focusedTabIndex === from) focusedTabIndex = to;
  else {
    if (focusedTabIndex > from) focusedTabIndex -= 1;

    if (focusedTabIndex >= to) focusedTabIndex += 1;
  }

  return { tabs, focusedTabIndex };
}

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

  let focusedTabIndex = 0;

  if (tabs.length > 0) {
    focusedTabIndex = focusedSurvivor ?? Math.max(0, Math.min(survivorsBefore, tabs.length - 1));
  }

  return { tabs, focusedTabIndex };
}
