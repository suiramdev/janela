import {
  layoutViolations,
  paneTerminalIDs,
  repairLayout,
  FRACTION_RANGE,
  type Pane,
  type SessionLayout,
  type TerminalID,
} from "@janela/core";
import { Match } from "effect";

export type PanePath = readonly ("first" | "second")[];

export interface LocalLayoutEntry {
  readonly base: SessionLayout;
  readonly local: SessionLayout;
}

export type TabCloseScope = "this" | "others" | "left" | "right" | "all";

const NO_TABS: readonly number[] = [];

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

export function withFocusedTab(layout: SessionLayout, index: number): SessionLayout {
  if (layout.tabs.length === 0) return layout;

  const clamped = Math.min(layout.tabs.length - 1, Math.max(0, Math.trunc(index)));

  return clamped === layout.focusedTabIndex ? layout : { ...layout, focusedTabIndex: clamped };
}

export function tabsInCloseScope(
  count: number,
  index: number,
  scope: TabCloseScope,
): readonly number[] {
  const every = Array.from({ length: Math.max(0, count) }, (_, at) => at);

  if (scope === "all") return every;

  if (index < 0 || index >= count) return NO_TABS;

  return Match.value(scope).pipe(
    Match.when("this", () => [index]),
    Match.when("others", () => every.filter((at) => at !== index)),
    Match.when("left", () => every.slice(0, index)),
    Match.when("right", () => every.slice(index + 1)),
    Match.exhaustive,
  );
}
