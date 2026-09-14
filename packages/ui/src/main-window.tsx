import { LayoutTwoColumnIcon, LayoutTwoRowIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DaemonConnection } from "@janela/client";
import {
  emptyLayout,
  focusedTab,
  FRACTION_RANGE,
  type Axis,
  type GridSize,
  type LayoutTab,
  type Pane,
  type SessionID,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import {
  Badge,
  Button,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Kbd,
  SIDEBAR_WIDTH,
  SidebarInset,
  SidebarProvider,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@janela/design";
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
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import { AppSidebar } from "./app-sidebar.tsx";
import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { createCommandDispatch, createTerminal, splitTerminal } from "./command-dispatch.ts";
import type { CommandID } from "./commands.ts";
import { ConnectionBanner } from "./connection-banner.tsx";
import {
  resolveLocalLayout,
  withFocusedTab,
  withFocusedTerminal,
  withSplitFraction,
  type PanePath,
} from "./layout-edits.ts";
import { SettingsScreen } from "./settings-window.tsx";
import { SheetHost } from "./sheets.tsx";

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
 * docs/product.md § Non-goals. Settings is the one thing that replaces it: the
 * same two columns, filled with tabs and a pane instead (`SettingsScreen`).
 *
 * ## What this view is looking at
 *
 * A **mirror**. The sessions below live in `janelad`; these stores hold the last
 * state it sent. When the connection drops, the mirror is still rendered — marked
 * stale — because the terminals themselves are unaffected and the user's work is
 * still running.
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

  const { view, commands, settings } = environment;
  const screen = useStoreValue(view, () => view.screen);

  const dispatch = useMemo(
    () =>
      createCommandDispatch({
        projects: environment.projects,
        sessions: environment.sessions,
        connection: environment.connection,
        view,
        native: environment.native,
      }),
    [environment, view],
  );

  const run = useCallback(
    (id: CommandID) => {
      // Best-effort, like every other request a view makes: a command issued while
      // the daemon is away fails, and the window keeps rendering the mirror.
      void dispatch(id).catch(swallowRequestFailure);
    },
    [dispatch],
  );

  useEffect(() => commands.subscribe(run), [commands, run]);

  useEffect(() => {
    // Once, at startup. Settings that refuse to load must not stop the window
    // painting, which is why the port answers with the defaults rather than
    // throwing.
    void settings.load().then((loaded) => {
      view.setSettings(loaded);
      return undefined;
    }, swallowRequestFailure);
  }, [settings, view]);

  // A selection naming a session the mirror no longer has renders as no selection.
  // The store repairs it on the next full snapshot; until then this is honest.
  const selected =
    selection !== undefined && sessions.some((session) => session.id === selection)
      ? selection
      : undefined;

  return (
    // One provider for the whole window: every tooltip in it then shares a single
    // hover delay, rather than each control deciding for itself how eager it is.
    <TooltipProvider delay={400}>
      <SidebarProvider
        style={SIDEBAR_VARIABLES}
        className="relative h-full min-h-0 overflow-hidden"
      >
        {screen.kind === "settings" ? (
          <SettingsScreen tab={screen.tab} />
        ) : (
          <>
            <AppSidebar dispatch={run} />
            <SidebarInset className="min-w-0 overflow-hidden">
              {selected === undefined ? (
                NO_SESSION_SELECTED
              ) : (
                // Deliberately unkeyed: one instance across session switches, so the
                // local layout of a session survives being switched away from.
                <SessionDetail sessionID={selected} />
              )}
            </SidebarInset>
          </>
        )}
        <ConnectionBanner />
        <SheetHost dispatch={run} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * The three states in which this window has nothing to show.
 *
 * Hoisted because they are constant: the empty pane is not worth an allocation on
 * every render, and `react-perf` would object to it as a prop anyway. The copy is
 * a single title each — none of the three has an action the user could take from
 * here that the sidebar and ⌘T do not already offer.
 */
const NO_SESSION_SELECTED = (
  <Empty className="h-full">
    <EmptyHeader>
      <EmptyTitle>No session selected</EmptyTitle>
    </EmptyHeader>
  </Empty>
);

const SESSION_NOT_FOUND = (
  <Empty className="h-full">
    <EmptyHeader>
      <EmptyTitle>Session not found</EmptyTitle>
    </EmptyHeader>
  </Empty>
);

const NO_TERMINALS_IN_SESSION = (
  <Empty className="h-full">
    <EmptyHeader>
      <EmptyTitle>No terminals in this session</EmptyTitle>
    </EmptyHeader>
  </Empty>
);

/**
 * The sidebar's width, as the CSS variables the primitive reads.
 *
 * `@janela/design`'s tokens stay authoritative: the registry component ships a
 * 16rem default, and this is where our 240px replaces it. The bounds travel with
 * it for a future drag affordance to honour — resizing is not built.
 */
const SIDEBAR_VARIABLES = {
  "--sidebar-width": `${SIDEBAR_WIDTH.ideal}px`,
  "--sidebar-width-minimum": `${SIDEBAR_WIDTH.minimum}px`,
  "--sidebar-width-maximum": `${SIDEBAR_WIDTH.maximum}px`,
} as CSSProperties;

// MARK: - Layout model

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
export function SessionDetail(props: { readonly sessionID: SessionID }): ReactElement {
  const sessionID = props.sessionID;
  const environment = useClientEnvironment();
  const { connection, onFocusedTerminalChange, view } = environment;
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);
  const isConnected = useStoreValue(connection, () => connection.status.kind === "connected");
  const layouts = useStoreValue(view, () => view.layouts);

  const session = sessions.find((candidate) => candidate.id === sessionID);
  const mirrorLayout = session?.layout ?? emptyLayout;
  const terminals = session?.terminals ?? NO_TERMINALS;
  const terminalIDs = terminals.map((terminal) => terminal.id);

  // The edits live in `ViewState` rather than here: a menu chord and a
  // notification both move pane focus, and neither of them is in this tree.
  const layout = resolveLocalLayout(layouts.get(sessionID), mirrorLayout, terminalIDs).local;

  const focusTerminal = useCallback(
    (id: TerminalID) => {
      view.applyLayout(sessionID, (current) => withFocusedTerminal(current, id));
    },
    [view, sessionID],
  );
  const focusTab = useCallback(
    (index: number) => {
      view.applyLayout(sessionID, (current) => withFocusedTab(current, index));
    },
    [view, sessionID],
  );
  const setFraction = useCallback(
    (path: PanePath, fraction: number) => {
      view.applyLayout(sessionID, (current) => withSplitFraction(current, path, fraction));
    },
    [view, sessionID],
  );
  const newTerminal = useCallback(() => {
    void createTerminal(connection, sessionID).catch(swallowRequestFailure);
  }, [connection, sessionID]);
  const splitTab = useCallback(
    (index: number, axis: Axis) => {
      // The tab's own focused pane, not the strip's: the control sits on a tab
      // that may not be the one showing, and splitting it means going there.
      const target = layout.tabs[index];
      if (target === undefined) return;
      view.applyLayout(sessionID, (current) => withFocusedTab(current, index));
      void splitTerminal(connection, sessionID, target.focusedTerminalID, axis).catch(
        swallowRequestFailure,
      );
    },
    [connection, layout, sessionID, view],
  );
  const moveTab = useCallback(
    (from: number, to: number) => {
      void connection
        .request({ type: "moveTab", sessionID, from, to })
        .catch(swallowRequestFailure);
    },
    [connection, sessionID],
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

  if (session === undefined) return SESSION_NOT_FOUND;

  return (
    <div className="flex h-full flex-col">
      <TabStrip
        layout={layout}
        terminals={terminals}
        onFocusTab={focusTab}
        onNewTerminal={newTerminal}
        onSplitTab={splitTab}
        onMoveTab={moveTab}
      />
      <div className="min-h-0 flex-1">
        {tab === undefined ? (
          NO_TERMINALS_IN_SESSION
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
 * The `+` is the same action ⌘T is: a new shell in a new tab. Each tab ends in
 * two split controls for its own focused pane, and tabs reorder by drag.
 *
 * ## Why the order is a request
 *
 * Tab order lives in `SessionLayout.tabs`, which the daemon owns and every
 * snapshot replaces. A local reorder would last until the next terminal exited.
 * So a drop sends `moveTab`, and the new order arrives back through the mirror
 * — the same way a split does.
 */
function TabStrip(props: {
  readonly layout: SessionLayout;
  readonly terminals: readonly TerminalDescriptor[];
  readonly onFocusTab: (index: number) => void;
  readonly onNewTerminal: () => void;
  readonly onSplitTab: (index: number, axis: Axis) => void;
  readonly onMoveTab: (from: number, to: number) => void;
}): ReactElement | null {
  const { layout, terminals, onFocusTab, onNewTerminal, onSplitTab, onMoveTab } = props;

  // The tab primitive's value is a string; this strip's is an index into
  // `layout.tabs`, which is what every layout edit is written in terms of.
  const handleValueChange = useCallback(
    (value: unknown) => {
      onFocusTab(Number(value));
    },
    [onFocusTab],
  );

  const [drag, setDrag] = useState<TabDrag | undefined>(undefined);
  const endDrag = useCallback(() => {
    setDrag(undefined);
  }, []);

  if (layout.tabs.length === 0) return null;
  return (
    // No `TabsContent`: the pane tree below this strip *is* the content of every
    // tab, and only the focused tab's panes are ever mounted (that is the laziness
    // rule, and a panel per tab would undo it).
    <Tabs
      value={String(layout.focusedTabIndex)}
      onValueChange={handleValueChange}
      className="shrink-0 gap-0"
    >
      <TabsList
        variant="line"
        aria-label="Terminals"
        className="border-border h-8 w-full shrink-0 justify-start gap-0 border-b px-1"
      >
        {layout.tabs.map((tab, index) => (
          <TabItem
            key={tab.focusedTerminalID}
            index={index}
            label={tabLabel(tab, terminals)}
            drag={drag}
            onDrag={setDrag}
            onDrop={onMoveTab}
            onDragEnd={endDrag}
            onSplit={onSplitTab}
          />
        ))}
        <Tooltip>
          <TooltipTrigger render={NEW_TERMINAL_BUTTON} onClick={onNewTerminal} />
          <TooltipContent>
            New Terminal <Kbd>⌘T</Kbd>
          </TooltipContent>
        </Tooltip>
      </TabsList>
    </Tabs>
  );
}

/** The tab being dragged, and the slot it would land in if dropped now. */
interface TabDrag {
  readonly from: number;
  /** Where the tab would go: an index into the strip *after* removal, or none yet. */
  readonly to: number | undefined;
}

/** The MIME type a tab drag carries. Private, so a file dropped on the strip is not a tab. */
const TAB_DRAG_TYPE = "application/x-janela-tab";

/**
 * Which slot a pointer over tab `index` means: before it on the left half, after
 * it on the right — as indices into the strip with the dragged tab removed.
 */
export function dropSlot(
  from: number,
  over: number,
  pointerX: number,
  bounds: { readonly left: number; readonly width: number },
): number {
  const after = pointerX - bounds.left > bounds.width / 2;
  const slot = after ? over + 1 : over;
  return slot > from ? slot - 1 : slot;
}

function TabItem(props: {
  readonly index: number;
  readonly label: string;
  readonly drag: TabDrag | undefined;
  readonly onDrag: (drag: TabDrag | undefined) => void;
  readonly onDrop: (from: number, to: number) => void;
  readonly onDragEnd: () => void;
  readonly onSplit: (index: number, axis: Axis) => void;
}): ReactElement {
  const { index, label, drag, onDrag, onDrop, onDragEnd, onSplit } = props;

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData(TAB_DRAG_TYPE, String(index));
      event.dataTransfer.effectAllowed = "move";
      onDrag({ from: index, to: undefined });
    },
    [index, onDrag],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (drag === undefined) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      const to = dropSlot(drag.from, index, event.clientX, bounds);
      if (to !== drag.to) onDrag({ from: drag.from, to });
    },
    [drag, index, onDrag],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (drag === undefined) return;
      event.preventDefault();
      const to = dropSlot(
        drag.from,
        index,
        event.clientX,
        event.currentTarget.getBoundingClientRect(),
      );
      onDragEnd();
      if (to !== drag.from) onDrop(drag.from, to);
    },
    [drag, index, onDrop, onDragEnd],
  );

  const splitVertically = useCallback(() => {
    onSplit(index, "horizontal");
  }, [index, onSplit]);
  const splitHorizontally = useCallback(() => {
    onSplit(index, "vertical");
  }, [index, onSplit]);

  // The indicator draws on the tab the slot sits beside: its left edge for a slot
  // before it, its right edge for one after — in strip indices, with the dragged
  // tab still in place.
  const indicator = drag === undefined || drag.to === undefined ? undefined : dropEdge(drag, index);

  return (
    <div
      className={cn(
        "group/tab relative flex h-full items-center",
        indicator === "before" && "shadow-[inset_2px_0_0_0_var(--color-foreground)]",
        indicator === "after" && "shadow-[inset_-2px_0_0_0_var(--color-foreground)]",
        drag?.from === index && "opacity-50",
      )}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <TabsTrigger
        value={String(index)}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
        // Room for the controls only on the tab that shows them all the time;
        // on the others they overlay the tail while hovered, so the strip's
        // widths do not jump as the pointer crosses it.
        className="max-w-48 flex-none truncate data-active:pr-13"
      >
        {label}
      </TabsTrigger>
      {/* Beside the trigger, not inside it: a button in a button is not HTML.
          Faded until the tab is hovered, focused or showing. */}
      <div className="bg-background absolute inset-y-0.5 right-1 flex items-center gap-0.5 rounded-md pl-1 opacity-0 transition-opacity duration-150 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 group-has-[[data-active]]/tab:opacity-100">
        <Tooltip>
          <TooltipTrigger render={SPLIT_VERTICALLY_BUTTON} onClick={splitVertically} />
          <TooltipContent>
            Split Vertically <Kbd>⌘D</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={SPLIT_HORIZONTALLY_BUTTON} onClick={splitHorizontally} />
          <TooltipContent>
            Split Horizontally <Kbd>⇧⌘D</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/** Which edge of tab `index` the drop slot in `drag` touches, if either. */
export function dropEdge(drag: TabDrag, index: number): "before" | "after" | undefined {
  // A slot that puts the tab back where it is draws nothing: there is no move to
  // preview, and a line beside the faded tab reads as one.
  if (drag.to === undefined || drag.to === drag.from) return undefined;
  // Back to strip indices: slots at or past the dragged tab shift by one.
  const slot = drag.to >= drag.from ? drag.to + 1 : drag.to;
  if (slot === index) return "before";
  if (slot === index + 1) return "after";
  return undefined;
}

/**
 * Hoisted so the triggers compose one element rather than allocating one per
 * render — `react-perf` forbids JSX as a prop, and this is why.
 */
const NEW_TERMINAL_BUTTON = (
  <Button variant="ghost" size="icon-xs" aria-label="New Terminal" className="ml-1">
    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_VERTICALLY_BUTTON = (
  <Button variant="ghost" size="icon-xs" aria-label="Split Vertically">
    <HugeiconsIcon icon={LayoutTwoColumnIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_HORIZONTALLY_BUTTON = (
  <Button variant="ghost" size="icon-xs" aria-label="Split Horizontally">
    <HugeiconsIcon icon={LayoutTwoRowIcon} strokeWidth={2} />
  </Button>
);

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
      className={`bg-border hover:bg-ring m-0 shrink-0 appearance-none p-0 ${
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

  const environment = useClientEnvironment();
  const view = environment.view;
  const store = environment.sessions;

  const handleRef = useRef<TerminalSurfaceHandle | null>(null);
  const isAttachedRef = useRef(false);
  const [attachViewport, setAttachViewport] = useState<GridSize | undefined>(undefined);

  // A ref callback rather than an effect: the handle exists at the moment React
  // hands it over, and the cleanup React runs on unmount is the unregistration.
  const registerSurface = useCallback(
    (handle: TerminalSurfaceHandle | null) => {
      handleRef.current = handle;
      if (handle === null) return undefined;
      return view.registerSurface(terminalID, handle);
    },
    [view, terminalID],
  );

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

    // The one place a client asks for a process: a session just created in the UI
    // carries `startsAutomatically`, which means "tell the opening client to ask".
    // A restored session carries `false`, so relaunching the app spawns nothing.
    //
    // Read from the store rather than from props: what matters is the state at the
    // moment of the attach, and a terminal that has since exited must not be
    // started again by a re-render.
    const owner = store.sessions.find((session) =>
      session.terminals.some((terminal) => terminal.id === terminalID),
    );
    const current = owner?.terminals.find((terminal) => terminal.id === terminalID);

    // **Start first.** `attach` names a *live* terminal — the daemon deliberately
    // never starts one for you (non-negotiable #5) and refuses an attach to a
    // terminal that has not spawned, which would leave this pane rendering nothing
    // and swallowing every keystroke. Nothing is missed by attaching a beat later:
    // the daemon answers an attach with a full repaint.
    const started = shouldStartOnAttach(current, store.terminalStates[terminalID])
      ? connection.request({ type: "startTerminal", terminalID }).catch(swallowRequestFailure)
      : Promise.resolve(undefined);

    let release: (() => void) | undefined;
    let unmounted = false;
    void started.then(() => {
      if (unmounted) return undefined;
      release = attachPane(connection, terminalID, feed, attachViewport);
      return undefined;
    });

    return () => {
      unmounted = true;
      isAttachedRef.current = false;
      release?.();
    };
  }, [isConnected, connection, terminalID, feed, attachViewport, store]);

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
        ref={registerSurface}
        label={`Terminal: ${title} — ${stateText}`}
        focused={isFocused}
        onInput={handleInput}
        onViewportChange={handleViewportChange}
      />
      {state?.kind === "running" ? null : (
        // A pane that is not running says so over its own corner: not a layer of
        // chrome above the terminal, which would cost a row of the grid.
        <Badge
          variant={isFailureState(state) ? "destructive" : "secondary"}
          className="pointer-events-none absolute right-1 bottom-1"
        >
          {stateText}
        </Badge>
      )}
    </div>
  );
}

const FOCUSED_PANE_STYLE = { outline: "2px solid AccentColor", outlineOffset: "-2px" } as const;
const UNFOCUSED_PANE_STYLE = { outline: "2px solid transparent", outlineOffset: "-2px" } as const;

/**
 * Whether attaching to this pane should also ask for its process.
 *
 * `startsAutomatically` is the daemon saying "the client that opens this should
 * ask" — set on the terminal a new session is created with, and `false` on every
 * terminal restored from the database, so relaunching the app spawns nothing.
 * Anything already running, exited or failed is left alone: a pane that finished
 * is not restarted by being looked at.
 */
export function shouldStartOnAttach(
  descriptor: TerminalDescriptor | undefined,
  state: TerminalState | undefined,
): boolean {
  if (descriptor?.startsAutomatically !== true) return false;
  return state === undefined || state.kind === "idle";
}

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
