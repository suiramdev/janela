import type { DaemonConnection, SessionStore } from "@janela/client";
import {
  emptyLayout,
  focusedTab,
  layoutViolations,
  paneTerminalIDs,
  repairLayout,
  FRACTION_RANGE,
  type Axis,
  type GridSize,
  type LayoutTab,
  type Pane,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { SIDEBAR_WIDTH } from "@janela/design";
import {
  animationFrameScheduler,
  coalescePerFrame,
  TerminalSurface,
  type TerminalSurfaceHandle,
} from "@janela/terminal-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { ConnectionBanner } from "./connection-banner.tsx";

export * from "./client-environment.tsx";

/**
 * The main window: projects and sessions on the left, terminals on the right.
 *
 * ## Structure
 *
 * ```text
 * ┌──────────────────┬────────────────────────────┐
 * │ ▸ scratch        │ ▸ agent  server  shell     │
 * │                  ├────────────────────────────┤
 * │ ▼ janela         │                │           │
 * │    • main        │    terminal    │ terminal  │
 * │    • fix/pty ●   │                │           │
 * │ ▸ api            │                │           │
 * └──────────────────┴────────────────────────────┘
 *   projects collapse    tabs, then splits
 *   sessions are buttons
 * ```
 *
 * That is the entire application. There is no inspector, no bottom panel, no
 * activity bar, and adding one should require an argument that survives
 * docs/product.md § Non-goals.
 *
 * ## What this view is looking at
 *
 * A **mirror**. The sessions below live in `janelad`; these stores hold the last
 * state it sent. When the connection drops, the mirror is still rendered — marked
 * stale — because the terminals themselves are unaffected and the user's work is
 * still running. See docs/decisions/0015-daemon-owned-sessions.md.
 *
 * ## What is local, and why
 *
 * Splitter fractions, pane focus, tab selection and project expansion are **local
 * view state**, seeded from the mirror and re-adopted whenever the mirror's layout
 * changes. That is not a preference: `ClientMessage` carries no message for any of
 * them, so there is nothing to send and nothing to persist. Inventing one is a
 * protocol change (#35), and until it exists these arrangements last as long as the
 * window does.
 */
export function MainWindow(): ReactElement {
  const environment = useClientEnvironment();
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const selection = useStoreValue(environment.sessions, () => environment.sessions.selection);

  // A selection naming a session the mirror no longer has renders as no selection.
  // The store repairs it on the next full snapshot; until then this is honest.
  const selected =
    selection !== undefined && sessions.some((session) => session.id === selection)
      ? selection
      : undefined;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div style={SIDEBAR_STYLE} className="shrink-0 overflow-y-auto border-r border-black/10">
        <Sidebar />
      </div>
      <div className="relative min-w-0 flex-1">
        {selected === undefined ? (
          <p className="flex h-full items-center justify-center text-sm text-neutral-500">
            No session selected
          </p>
        ) : (
          // Deliberately unkeyed: one instance across session switches, so the
          // local layout of a session survives being switched away from.
          <SessionDetail sessionID={selected} />
        )}
      </div>
      <ConnectionBanner />
    </div>
  );
}

/**
 * A fixed ideal width, with the token's bounds declared for a future drag
 * affordance to honour. Resizing the sidebar is not in this issue.
 */
const SIDEBAR_STYLE = {
  width: SIDEBAR_WIDTH.ideal,
  minWidth: SIDEBAR_WIDTH.minimum,
  maxWidth: SIDEBAR_WIDTH.maximum,
} as const;

// MARK: - Sidebar model

/** What a session row shows, in precedence order. */
export type SessionStatus = "attention" | "running" | "failed" | "idle";

/**
 * One row of the sidebar, flat.
 *
 * A flat array rather than a tree, and that is the point: the shape is fixed at two
 * levels by docs/decisions/0009-projects-sessions-terminals.md, and a recursive row
 * type would quietly permit the third level that ADR forbids.
 */
export type SidebarRow =
  | {
      readonly kind: "session";
      readonly session: Session;
      readonly status: SessionStatus;
      readonly indented: boolean;
    }
  | { readonly kind: "project"; readonly project: Project; readonly isExpanded: boolean };

/**
 * Derived only from what the daemon reported.
 *
 * A terminal with no reported state counts as nothing: the daemon has not spoken
 * about it, and rendering it as running would be a lie this client invented
 * (AGENTS.md § Non-negotiables 6).
 */
export function sessionStatus(
  session: Session,
  states: Readonly<Record<TerminalID, TerminalState>>,
): SessionStatus {
  let running = false;
  let failed = false;
  for (const terminal of session.terminals) {
    const state = states[terminal.id];
    if (state === undefined) continue;
    if (state.kind === "needsAttention") return "attention";
    if (state.kind === "running") running = true;
    else if (state.kind === "failed") failed = true;
    else if (state.kind === "exited" && state.code !== 0) failed = true;
  }
  if (running) return "running";
  return failed ? "failed" : "idle";
}

/**
 * Standalone sessions first, then one row per project with its sessions inside.
 *
 * Grouping happens here rather than through `SessionStore.inProject`, which builds
 * a fresh array per call and would therefore be a new reference on every render.
 * Mirror order throughout: the daemon decided the order and this does not second-
 * guess it.
 */
export function sidebarRows(
  projects: readonly Project[],
  sessions: readonly Session[],
  states: Readonly<Record<TerminalID, TerminalState>>,
  expansionOverrides: ReadonlyMap<ProjectID, boolean>,
): readonly SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const session of sessions) {
    if (session.projectID === undefined) {
      rows.push({
        kind: "session",
        session,
        status: sessionStatus(session, states),
        indented: false,
      });
    }
  }
  for (const project of projects) {
    const isExpanded = expansionOverrides.get(project.id) ?? project.isExpanded;
    rows.push({ kind: "project", project, isExpanded });
    if (!isExpanded) continue;
    for (const session of sessions) {
      if (session.projectID === project.id) {
        rows.push({
          kind: "session",
          session,
          status: sessionStatus(session, states),
          indented: true,
        });
      }
    }
  }
  return rows;
}

/** The state, as words. It travels beside the colour, never instead of it. */
export function statusText(status: SessionStatus): string {
  return STATUS_TEXT[status];
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  attention: "needs attention",
  running: "running",
  failed: "failed",
  idle: "idle",
};

const STATUS_DOT: Record<SessionStatus, string> = {
  attention: "bg-attention",
  running: "bg-running",
  failed: "bg-failure",
  idle: "bg-transparent",
};

// MARK: - Sidebar

const NO_OVERRIDES: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

/**
 * The one field of the mirror a client owns.
 *
 * `SessionStore.selection` is documented as purely local — never sent, never
 * received — and its setter notifies, so this assignment is the whole of "select a
 * session". It lives in a function rather than inline in the view because it is
 * the only place any view writes to a store, and that deserves to be one line
 * someone can find.
 */
function selectSession(store: SessionStore, id: SessionID): void {
  store.selection = id;
}

/**
 * Two levels, and never a third: standalone sessions, then collapsible projects
 * with their sessions inside.
 *
 * Deliberately a flat list of buttons rather than a recursive tree component.
 * Expanding does no work — it flips a local boolean and reads nothing, because a
 * project that had to load anything to expand would have broken the laziness rule
 * upstream (docs/performance.md § Interaction).
 *
 * The expansion override is local. `Project.isExpanded` is the mirror's value and
 * the only way to change it would be a protocol message that does not exist; so a
 * click overrides it here and the override lasts as long as the window (#35).
 */
export function Sidebar(): ReactElement {
  const environment = useClientEnvironment();
  const projects = useStoreValue(environment.projects, () => environment.projects.projects);
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const selection = useStoreValue(environment.sessions, () => environment.sessions.selection);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);

  const [overrides, setOverrides] = useState(NO_OVERRIDES);
  const rows = useMemo(
    () => sidebarRows(projects, sessions, states, overrides),
    [projects, sessions, states, overrides],
  );

  const sessionStore = environment.sessions;
  const select = useCallback(
    (id: SessionID) => {
      selectSession(sessionStore, id);
    },
    [sessionStore],
  );

  const toggle = useCallback((id: ProjectID, wasExpanded: boolean) => {
    setOverrides((current) => new Map(current).set(id, !wasExpanded));
  }, []);

  return (
    <nav aria-label="Sessions" className="flex flex-col gap-px p-2">
      {rows.map((row) =>
        row.kind === "project" ? (
          <ProjectRow
            key={row.project.id}
            project={row.project}
            isExpanded={row.isExpanded}
            onToggle={toggle}
          />
        ) : (
          <SessionRow
            key={row.session.id}
            session={row.session}
            status={row.status}
            indented={row.indented}
            isSelected={row.session.id === selection}
            onSelect={select}
          />
        ),
      )}
    </nav>
  );
}

function ProjectRow(props: {
  readonly project: Project;
  readonly isExpanded: boolean;
  readonly onToggle: (id: ProjectID, wasExpanded: boolean) => void;
}): ReactElement {
  const { project, isExpanded, onToggle } = props;
  const handleClick = useCallback(() => {
    onToggle(project.id, isExpanded);
  }, [onToggle, project.id, isExpanded]);

  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      onClick={handleClick}
      className="rounded-small flex items-center gap-1 px-2 py-1 text-left text-sm font-medium hover:bg-black/5"
    >
      <span
        aria-hidden="true"
        className={`inline-block motion-safe:transition-transform ${isExpanded ? "rotate-90" : ""}`}
      >
        ▸
      </span>
      <span className="truncate">{project.name}</span>
    </button>
  );
}

function SessionRow(props: {
  readonly session: Session;
  readonly status: SessionStatus;
  readonly indented: boolean;
  readonly isSelected: boolean;
  readonly onSelect: (id: SessionID) => void;
}): ReactElement {
  const { session, status, indented, isSelected, onSelect } = props;
  const handleClick = useCallback(() => {
    onSelect(session.id);
  }, [onSelect, session.id]);

  return (
    <button
      type="button"
      // The status is in the name, not only in the dot: a colour alone is a state
      // a screen reader cannot read and a colour-blind user cannot distinguish.
      aria-label={`${session.name} — ${statusText(status)}`}
      aria-current={isSelected ? "true" : undefined}
      onClick={handleClick}
      className={`rounded-small flex items-center gap-2 py-1 pr-2 text-left text-sm hover:bg-black/5 ${
        indented ? "pl-6" : "pl-2"
      } ${isSelected ? "bg-black/10" : ""}`}
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
      <span className="truncate">{session.name}</span>
    </button>
  );
}

// MARK: - Layout model

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
 */
export function resolveLocalLayout(
  entry: LocalLayoutEntry | undefined,
  mirror: SessionLayout,
  existingTerminalIDs: readonly TerminalID[],
): LocalLayoutEntry {
  if (entry !== undefined && entry.base === mirror) return entry;
  const violations = layoutViolations(mirror, existingTerminalIDs);
  const adopted = violations.length === 0 ? mirror : repairLayout(mirror, existingTerminalIDs);
  return { base: mirror, local: adopted };
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

/** A tab's own title, else the focused terminal's, else something honest. */
export function tabLabel(tab: LayoutTab, terminals: readonly TerminalDescriptor[]): string {
  if (tab.title !== undefined) return tab.title;
  return terminals.find((terminal) => terminal.id === tab.focusedTerminalID)?.title ?? "Terminal";
}

/**
 * A terminal's state, as words.
 *
 * An absent state reads as idle, which is what the daemon's `idle` means:
 * configured, nothing spawned. It is not an inference about a running process.
 */
export function terminalStateText(state: TerminalState | undefined): string {
  if (state === undefined) return "idle";
  switch (state.kind) {
    case "idle":
      return "idle";
    case "running":
      return "running";
    case "needsAttention":
      return "needs attention";
    case "exited":
      return `exited (${state.code})`;
    case "failed":
      return state.message;
  }
}

function isFailureState(state: TerminalState | undefined): boolean {
  if (state === undefined) return false;
  return state.kind === "failed" || (state.kind === "exited" && state.code !== 0);
}

// MARK: - Session detail

const NO_LAYOUTS: ReadonlyMap<string, LocalLayoutEntry> = new Map<string, LocalLayoutEntry>();

/**
 * A request from a view is best-effort.
 *
 * Failing while the daemon is away is routine — nothing is queued, by design — and
 * the stale mirror keeps rendering either way. `@janela/ui` has no logger and wants
 * none: a view that logged every failed request during a reconnect would write the
 * user's session list into the system log.
 */
function swallowRequestFailure(): undefined {
  return undefined;
}

/**
 * Tab strip, split view, and the focused terminal.
 *
 * Holds one local layout per session, which is why `MainWindow` must not key this
 * component by session: switching away and back keeps the arrangement. It does not
 * survive the window closing — persistence needs a protocol message (#35).
 */
export function SessionDetail(props: { readonly sessionID: string }): ReactElement {
  const sessionID = props.sessionID;
  const environment = useClientEnvironment();
  const { connection, onFocusedTerminalChange } = environment;
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);
  const isConnected = useStoreValue(connection, () => connection.status.kind === "connected");

  const sessionStore = environment.sessions;
  const session = sessions.find((candidate) => candidate.id === sessionID);
  const mirrorLayout = session?.layout ?? emptyLayout;
  const terminals = session?.terminals ?? NO_TERMINALS;
  const terminalIDs = terminals.map((terminal) => terminal.id);

  // Local edits, keyed by session. Written only from an event; the resolution
  // below is pure, so there is nothing for an effect to synchronise.
  const [edits, setEdits] = useState(NO_LAYOUTS);
  const layout = resolveLocalLayout(edits.get(sessionID), mirrorLayout, terminalIDs).local;

  const applyLayout = useCallback(
    (change: (layout: SessionLayout) => SessionLayout) => {
      // The mirror is read here, at the moment of the edit, rather than captured
      // from a render: an edit applies to the layout that is on screen now, and
      // the mirror may have replaced it since this handler was created.
      const live = sessionStore.sessions.find((candidate) => candidate.id === sessionID);
      const mirror = live?.layout ?? emptyLayout;
      const ids = (live?.terminals ?? NO_TERMINALS).map((terminal) => terminal.id);
      setEdits((current) => {
        const resolved = resolveLocalLayout(current.get(sessionID), mirror, ids);
        const local = change(resolved.local);
        if (local === resolved.local) return current;
        return new Map(current).set(sessionID, { base: resolved.base, local });
      });
    },
    [sessionStore, sessionID],
  );

  const focusTerminal = useCallback(
    (id: TerminalID) => {
      applyLayout((current) => withFocusedTerminal(current, id));
    },
    [applyLayout],
  );
  const focusTab = useCallback(
    (index: number) => {
      applyLayout((current) => withFocusedTab(current, index));
    },
    [applyLayout],
  );
  const setFraction = useCallback(
    (path: PanePath, fraction: number) => {
      applyLayout((current) => withSplitFraction(current, path, fraction));
    },
    [applyLayout],
  );

  const tab = focusedTab(layout);
  const focusedTerminalID = tab?.focusedTerminalID;

  useEffect(() => {
    onFocusedTerminalChange?.(focusedTerminalID);
  }, [onFocusedTerminalChange, focusedTerminalID]);

  // Separate, and deliberately: this fires only on unmount. Folding it into the
  // effect above would send `undefined` between every two focus changes.
  useEffect(
    () => () => {
      onFocusedTerminalChange?.(undefined);
    },
    [onFocusedTerminalChange],
  );

  if (session === undefined) {
    return (
      <p className="flex h-full items-center justify-center text-sm text-neutral-500">
        Session not found
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TabStrip layout={layout} terminals={terminals} onFocusTab={focusTab} />
      <div className="min-h-0 flex-1">
        {tab === undefined ? (
          <p className="flex h-full items-center justify-center text-sm text-neutral-500">
            No terminals in this session
          </p>
        ) : (
          <PaneView
            pane={tab.root}
            path={ROOT_PATH}
            focusedTerminalID={tab.focusedTerminalID}
            terminals={terminals}
            states={states}
            connection={connection}
            isConnected={isConnected}
            onFocusTerminal={focusTerminal}
            onFraction={setFraction}
          />
        )}
      </div>
    </div>
  );
}

const NO_TERMINALS: readonly TerminalDescriptor[] = [];
const ROOT_PATH: PanePath = [];

/**
 * Always rendered when the session has a tab, even a single one.
 *
 * There is no "+" here and no keyboard chord anywhere in this package: creation and
 * bindings are #37's, and this is the row they will land in.
 */
function TabStrip(props: {
  readonly layout: SessionLayout;
  readonly terminals: readonly TerminalDescriptor[];
  readonly onFocusTab: (index: number) => void;
}): ReactElement | null {
  const { layout, terminals, onFocusTab } = props;
  if (layout.tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Terminals"
      className="flex shrink-0 items-center gap-px border-b border-black/10 px-1"
    >
      {layout.tabs.map((tab, index) => (
        <TabButton
          key={tab.focusedTerminalID}
          index={index}
          label={tabLabel(tab, terminals)}
          isSelected={index === layout.focusedTabIndex}
          onFocusTab={onFocusTab}
        />
      ))}
    </div>
  );
}

function TabButton(props: {
  readonly index: number;
  readonly label: string;
  readonly isSelected: boolean;
  readonly onFocusTab: (index: number) => void;
}): ReactElement {
  const { index, label, isSelected, onFocusTab } = props;
  const handleClick = useCallback(() => {
    onFocusTab(index);
  }, [onFocusTab, index]);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isSelected}
      onClick={handleClick}
      className={`rounded-small truncate px-3 py-1 text-xs ${
        isSelected ? "bg-black/10 font-medium" : "hover:bg-black/5"
      }`}
    >
      {label}
    </button>
  );
}

interface PaneViewProps {
  readonly pane: Pane;
  readonly path: PanePath;
  readonly focusedTerminalID: TerminalID;
  readonly terminals: readonly TerminalDescriptor[];
  readonly states: Readonly<Record<TerminalID, TerminalState>>;
  readonly connection: DaemonConnection;
  readonly isConnected: boolean;
  readonly onFocusTerminal: (id: TerminalID) => void;
  readonly onFraction: (path: PanePath, fraction: number) => void;
}

/** The split tree, rendered. Bounded by `MAXIMUM_PANE_DEPTH` upstream. */
function PaneView(props: PaneViewProps): ReactElement {
  const { pane, path } = props;

  const firstPath = useMemo<PanePath>(() => [...path, "first"], [path]);
  const secondPath = useMemo<PanePath>(() => [...path, "second"], [path]);
  const firstStyle = useMemo(
    () => (pane.kind === "split" ? { flexBasis: `${pane.fraction * 100}%` } : undefined),
    [pane],
  );

  if (pane.kind === "terminal") {
    return (
      <TerminalPane
        terminalID={pane.id}
        descriptor={props.terminals.find((terminal) => terminal.id === pane.id)}
        state={props.states[pane.id]}
        isFocused={props.focusedTerminalID === pane.id}
        connection={props.connection}
        isConnected={props.isConnected}
        onFocusTerminal={props.onFocusTerminal}
      />
    );
  }

  // `horizontal` divides side by side, so the box is a row and the divider is
  // vertical — see the `Axis` doc comment in @janela/core.
  const isRow = pane.axis === "horizontal";
  return (
    <div className={`flex h-full w-full ${isRow ? "flex-row" : "flex-col"}`}>
      <div style={firstStyle} className="min-h-0 min-w-0 shrink-0 grow-0">
        <PaneView {...props} pane={pane.first} path={firstPath} />
      </div>
      <Divider
        axis={pane.axis}
        fraction={pane.fraction}
        path={path}
        onFraction={props.onFraction}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaneView {...props} pane={pane.second} path={secondPath} />
      </div>
    </div>
  );
}

/** One arrow press moves the divider by this much, in percent. */
const DIVIDER_STEP = 2;
const DIVIDER_MINIMUM = Math.round(FRACTION_RANGE.minimum * 100);
const DIVIDER_MAXIMUM = Math.round(FRACTION_RANGE.maximum * 100);

/**
 * The draggable divider.
 *
 * A real `<input type="range">` rather than a div with `role="separator"`: a
 * window splitter *is* a value in a range, and the browser then supplies keyboard
 * adjustment, the value, and the announcement for free. Arrow keys shadow nothing
 * — a divider is not a terminal — and no `Ctrl` chord is bound here or anywhere
 * else in this package.
 *
 * Pointer moves are coalesced to one layout update per frame. Each one resizes
 * panes, which resizes surfaces, which votes one `resize` per terminal per frame —
 * and every vote ends in a `TIOCSWINSZ` and a `SIGWINCH` two processes away, so a
 * vote per mouse move is a storm (docs/performance.md § Interaction budgets).
 */
function Divider(props: {
  readonly axis: Axis;
  readonly fraction: number;
  readonly path: PanePath;
  readonly onFraction: (path: PanePath, fraction: number) => void;
}): ReactElement {
  const { axis, fraction, path, onFraction } = props;

  const flush = useMemo(
    () =>
      coalescePerFrame<number>((value) => {
        onFraction(path, value);
      }, animationFrameScheduler()),
    [onFraction, path],
  );
  useEffect(
    () => () => {
      flush.cancel();
    },
    [flush],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onFraction(path, event.currentTarget.valueAsNumber / 100);
    },
    [onFraction, path],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLInputElement>) => {
    // The native drag would map the pointer to this 4px-wide box and jump the
    // value to an end. The move handler measures the split instead — but the
    // element still has to take focus, which `preventDefault` would have stopped.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const box = event.currentTarget.parentElement?.getBoundingClientRect();
      if (box === undefined) return;
      const along =
        axis === "horizontal"
          ? (event.clientX - box.left) / box.width
          : (event.clientY - box.top) / box.height;
      flush.push(along);
    },
    [axis, flush],
  );

  const handlePointerUp = useCallback((event: PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <input
      type="range"
      aria-label="Resize panes"
      // The divider of a side-by-side split is itself vertical.
      aria-orientation={axis === "horizontal" ? "vertical" : "horizontal"}
      min={DIVIDER_MINIMUM}
      max={DIVIDER_MAXIMUM}
      step={DIVIDER_STEP}
      value={Math.round(fraction * 100)}
      onChange={handleChange}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onLostPointerCapture={handlePointerUp}
      className={`m-0 shrink-0 appearance-none bg-black/10 p-0 ${
        axis === "horizontal" ? "h-full w-1 cursor-col-resize" : "h-1 w-full cursor-row-resize"
      }`}
    />
  );
}

/**
 * One attached terminal.
 *
 * Mounted only for the focused tab: an unfocused tab renders nothing, attaches
 * nothing and costs nothing, which is the laziness rule applied to the surface
 * that costs the most (AGENTS.md § Non-negotiables 5).
 */
function TerminalPane(props: {
  readonly terminalID: TerminalID;
  readonly descriptor: TerminalDescriptor | undefined;
  readonly state: TerminalState | undefined;
  readonly isFocused: boolean;
  readonly connection: DaemonConnection;
  readonly isConnected: boolean;
  readonly onFocusTerminal: (id: TerminalID) => void;
}): ReactElement {
  const { terminalID, descriptor, state, isFocused, connection, isConnected, onFocusTerminal } =
    props;

  const handleRef = useRef<TerminalSurfaceHandle | null>(null);
  const isAttachedRef = useRef(false);
  const [attachViewport, setAttachViewport] = useState<GridSize | undefined>(undefined);

  const feed = useCallback((bytes: Uint8Array) => {
    handleRef.current?.feed(bytes);
  }, []);

  const handleViewportChange = useCallback(
    (size: GridSize) => {
      // Before the attach, the measurement *is* the attach viewport. Afterwards it
      // is a vote, and the attach is not redone for it.
      if (!isAttachedRef.current) {
        setAttachViewport(size);
        return;
      }
      connection.request({ type: "resize", terminalID, size }).catch(swallowRequestFailure);
    },
    [connection, terminalID],
  );

  useEffect(() => {
    if (!isConnected || attachViewport === undefined) return;
    isAttachedRef.current = true;
    const release = attachPane(connection, terminalID, feed, attachViewport);
    return () => {
      isAttachedRef.current = false;
      release();
    };
  }, [isConnected, connection, terminalID, feed, attachViewport]);

  const handleInput = useCallback(
    (bytes: Uint8Array) => {
      connection.sendInput(bytes, terminalID);
    },
    [connection, terminalID],
  );

  const handleFocusCapture = useCallback(() => {
    onFocusTerminal(terminalID);
  }, [onFocusTerminal, terminalID]);

  const title = descriptor?.title ?? "Terminal";
  const stateText = terminalStateText(state);

  return (
    <div
      onFocusCapture={handleFocusCapture}
      // A 2px outline either way, so focusing a pane never moves anything. The
      // system accent keyword follows the user's macOS setting with no new token.
      style={isFocused ? FOCUSED_PANE_STYLE : UNFOCUSED_PANE_STYLE}
      className="relative h-full w-full"
    >
      <TerminalSurface
        ref={handleRef}
        label={`Terminal: ${title} — ${stateText}`}
        focused={isFocused}
        onInput={handleInput}
        onViewportChange={handleViewportChange}
      />
      {state?.kind === "running" ? null : (
        <p
          className={`rounded-small pointer-events-none absolute right-1 bottom-1 bg-black/40 px-1 text-[10px] ${
            isFailureState(state) ? "text-failure" : "text-white"
          }`}
        >
          {stateText}
        </p>
      )}
    </div>
  );
}

const FOCUSED_PANE_STYLE = { outline: "2px solid AccentColor", outlineOffset: "-2px" } as const;
const UNFOCUSED_PANE_STYLE = { outline: "2px solid transparent", outlineOffset: "-2px" } as const;

/**
 * Subscribes, then attaches — in that order.
 *
 * The daemon answers an `attach` with a full repaint, so a handler registered after
 * the request would miss the screen it just asked for. That is also why there is no
 * loading state to design: the reply *is* the content.
 *
 * The returned cleanup unsubscribes and then detaches. Both requests are
 * best-effort; a detach that fails because the connection is gone has already
 * happened as far as the daemon is concerned.
 */
export function attachPane(
  connection: Pick<DaemonConnection, "request" | "onOutput">,
  terminalID: TerminalID,
  feed: (bytes: Uint8Array) => void,
  viewport: GridSize,
): () => void {
  const unsubscribe = connection.onOutput(terminalID, feed);
  connection.request({ type: "attach", terminalID, viewport }).catch(swallowRequestFailure);
  return () => {
    unsubscribe();
    connection.request({ type: "detach", terminalID }).catch(swallowRequestFailure);
  };
}
