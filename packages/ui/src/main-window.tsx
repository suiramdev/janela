import {
  Cancel01Icon,
  ComputerTerminal01Icon,
  FolderAddIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DaemonConnection } from "@janela/client";
import {
  emptyLayout,
  focusedTab,
  FRACTION_RANGE,
  paneTerminalIDs,
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Kbd,
  Separator,
  SidebarProvider,
  SizeProvider,
  useSize,
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
  type DragEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import { AppSidebar } from "./app-sidebar.tsx";
import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import {
  closeTerminals,
  createCommandDispatch,
  createTerminal,
  splitTerminal,
} from "./command-dispatch.ts";
import type { CommandID } from "./commands.ts";
import { ConfirmationHost } from "./confirmation-dialog.tsx";
import { ConnectionBanner } from "./connection-banner.tsx";
import { ContextMenuRegion, type MenuRow } from "./context-menu-region.tsx";
import {
  resolveLocalLayout,
  withFocusedTab,
  withFocusedTerminal,
  withSplitFraction,
  type PanePath,
} from "./layout-edits.ts";
import { tabMenuRows, terminalMenuRows, windowMenuRows } from "./menu-rows.ts";
import { SettingsScreen } from "./settings-window.tsx";
import { SheetHost } from "./sheets.tsx";
import {
  ContentCard,
  PANE_REGION,
  ShowSidebarBar,
  ShowSidebarButton,
  WindowBar,
  WindowColumn,
} from "./window-chrome.tsx";

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
        confirmations: environment.confirmations,
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

  const windowRows = useMemo(() => windowMenuRows(run), [run]);

  return (
    // One provider for the whole window: every tooltip in it then shares a single
    // hover delay, rather than each control deciding for itself how eager it is.
    <TooltipProvider delay={400}>
      {/* One ladder step for the window: this application is dense, so every
          control the sidebar builds runs on the `compact` step — 28px rows, 12px
          text, 14px glyphs — rather than the registry's 36px default. The width
          comes from `SIDEBAR_WIDTH` in @janela/design, which the primitive reads
          itself; the rail resizes within that token's bounds. */}
      <SizeProvider size="compact">
        {/* The window's own menu, under every other one: a right-click that
            lands on the sidebar's empty space, the bar, or the card between
            panes has *something* under it, and what it has is the three actions
            that start something. A more specific region — a project row, a tab,
            a terminal — sits inside this one and answers first: Base UI's
            trigger stops the event at the innermost one.

            `contents`, so the region adds no box: the sidebar and the column
            are still the grid the provider laid out. */}
        <ContextMenuRegion label="Janela" rows={windowRows} className="contents">
          <SidebarProvider className="relative h-full min-h-0 overflow-hidden">
            {screen.kind === "settings" ? (
              <SettingsScreen route={screen.route} />
            ) : (
              <>
                <AppSidebar dispatch={run} />
                {/* The column, not the card — see `WindowColumn`. */}
                <WindowColumn>
                  {selected === undefined ? (
                    <WelcomeScreen dispatch={run} />
                  ) : (
                    // Deliberately unkeyed: one instance across session switches, so the
                    // local layout of a session survives being switched away from.
                    <SessionDetail sessionID={selected} />
                  )}
                </WindowColumn>
              </>
            )}
            <ConnectionBanner />
            <SheetHost dispatch={run} />
            {/* Above the sheet, and the only surface that may cover one: a
                question about ending something is asked over whatever the user
                was doing, including an open sheet. */}
            <ConfirmationHost />
          </SidebarProvider>
        </ContextMenuRegion>
      </SizeProvider>
    </TooltipProvider>
  );
}

/**
 * The window with no session open.
 *
 * Not a shrug: this is the first screen of a fresh install and the screen a user
 * lands on after removing their last session, so it carries the two creation
 * actions rather than describing them. Both are `CommandID`s — the same rows the
 * sidebar and the menu bar dispatch — so there is one implementation of "start a
 * session" in the application.
 */
function WelcomeScreen(props: { readonly dispatch: (id: CommandID) => void }): ReactElement {
  const { dispatch } = props;

  const newSession = useCallback(() => {
    dispatch("newSession");
  }, [dispatch]);
  const addProject = useCallback(() => {
    dispatch("addProject");
  }, [dispatch]);

  return (
    <>
      <ShowSidebarBar />
      <ContentCard>
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No session open</EmptyTitle>
            <EmptyDescription>
              A session is a directory with terminals in it. Start one in any folder, or add a
              project to keep its sessions together — whatever you start keeps running when this
              window closes.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="lg" onClick={newSession}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
                New Session
                <Kbd>⌘N</Kbd>
              </Button>
              <Button size="lg" variant="outline" onClick={addProject}>
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
                Add Project
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </ContentCard>
    </>
  );
}

/**
 * The two states in which a *selected* session has nothing to show.
 *
 * Hoisted because they are constant: the empty pane is not worth an allocation on
 * every render, and `react-perf` would object to it as a prop anyway.
 */
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
      <EmptyDescription>Press ⌘T, or use the + in the tab bar, to start one.</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

// MARK: - Layout model

/** A tab's own title, else the focused terminal's, else something honest. */
export function tabLabel(tab: LayoutTab, terminals: readonly TerminalDescriptor[]): string {
  if (tab.title !== undefined) return tab.title;
  return terminals.find((terminal) => terminal.id === tab.focusedTerminalID)?.title ?? "Terminal";
}

/**
 * Every terminal a tab holds: its whole pane tree, not the half it is showing.
 *
 * What "close this tab" means, and why it is a function rather than a line
 * inside the handler — a tab is an *arrangement of* terminals, so anything
 * acting on a tab acts on all of them. An index the layout does not have yields
 * none, which closes nothing.
 */
export function tabTerminals(layout: SessionLayout, index: number): readonly TerminalID[] {
  const tab = layout.tabs[index];
  return tab === undefined ? NO_TERMINAL_IDS : paneTerminalIDs(tab.root);
}

const NO_TERMINAL_IDS: readonly TerminalID[] = [];

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
  const { confirmations, connection, onFocusedTerminalChange, view } = environment;
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
  const splitPane = useCallback(
    (id: TerminalID, axis: Axis) => {
      // The pane the pointer is on, not the focused one: a right-click is
      // allowed to act on a pane you have not typed in yet.
      void splitTerminal(connection, sessionID, id, axis).catch(swallowRequestFailure);
    },
    [connection, sessionID],
  );
  const moveTab = useCallback(
    (from: number, to: number) => {
      void connection
        .request({ type: "moveTab", sessionID, from, to })
        .catch(swallowRequestFailure);
    },
    [connection, sessionID],
  );
  const closeTab = useCallback(
    (index: number) => {
      const closing = tabTerminals(layout, index);
      if (session === undefined || closing.length === 0) return;
      void closeTerminals(
        { sessions: environment.sessions, connection, confirmations },
        session,
        closing,
        "tab",
      ).catch(swallowRequestFailure);
    },
    [confirmations, connection, environment.sessions, layout, session],
  );
  const closePane = useCallback(
    (id: TerminalID) => {
      if (session === undefined) return;
      void closeTerminals(
        { sessions: environment.sessions, connection, confirmations },
        session,
        [id],
        "pane",
      ).catch(swallowRequestFailure);
    },
    [confirmations, connection, environment.sessions, session],
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
      <>
        <ShowSidebarBar />
        <ContentCard>{SESSION_NOT_FOUND}</ContentCard>
      </>
    );
  }

  return (
    <>
      {/* A session with no tabs renders no strip, and something still has to
          hold the window's top-left corner: the bar the other empty screens
          use, carrying the room for the window controls and the one way back
          from a sidebar that is off screen. */}
      {layout.tabs.length === 0 ? (
        <ShowSidebarBar />
      ) : (
        <TabStrip
          layout={layout}
          terminals={terminals}
          onFocusTab={focusTab}
          onNewTerminal={newTerminal}
          onSplitTab={splitTab}
          onMoveTab={moveTab}
          onCloseTab={closeTab}
        />
      )}
      <div className={PANE_REGION}>
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
            onClosePane={closePane}
            onSplitPane={splitPane}
            onNewTerminal={newTerminal}
          />
        )}
      </div>
    </>
  );
}

const NO_TERMINALS: readonly TerminalDescriptor[] = [];
/** Before a terminal's menu has been opened once, it has no rows to draw. */
const NO_MENU_ROWS: readonly MenuRow[] = [];
const ROOT_PATH: PanePath = [];

/**
 * The strip, for a session that has at least one tab — which its caller decides,
 * because the screen with no tabs needs a bar of its own anyway.
 *
 * Compact rounded tabs on the left, each with its own close button, and on the
 * right the three controls that act on the tab showing: split it vertically,
 * split it horizontally, or open another one. Those three sit at the strip's end
 * rather than on each tab because they are one set of controls for *the current*
 * tab — a copy per tab is three buttons times however many tabs, all but three
 * of which are unreachable without first switching to that tab anyway.
 *
 * Closing is the exception, and belongs on the tab: it is the one action whose
 * target is the tab you are pointing at rather than the one you are in, and
 * "switch to it, then close it" is two clicks to throw something away.
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
  readonly onCloseTab: (index: number) => void;
}): ReactElement {
  const { layout, terminals, onFocusTab, onNewTerminal, onSplitTab, onMoveTab, onCloseTab } = props;

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

  const focusedTabIndex = layout.focusedTabIndex;
  const splitVertically = useCallback(() => {
    onSplitTab(focusedTabIndex, "horizontal");
  }, [onSplitTab, focusedTabIndex]);
  const splitHorizontally = useCallback(() => {
    onSplitTab(focusedTabIndex, "vertical");
  }, [onSplitTab, focusedTabIndex]);

  return (
    <WindowBar>
      <ShowSidebarButton />
      {/* No `TabsContent`: the pane tree below this strip *is* the content of
          every tab, and only the focused tab's panes are ever mounted (that is
          the laziness rule, and a panel per tab would undo it). */}
      <Tabs
        value={String(focusedTabIndex)}
        onValueChange={handleValueChange}
        className="min-w-0 flex-1 gap-0"
      >
        <TabsList
          aria-label="Terminals"
          // No height here: `TabsList` is on the size ladder, so the strip is one
          // control tall and a tab lines up with the buttons at the far end of
          // the bar and with a sidebar row.
          //
          // `scroll-fade-x` when the tabs outrun the strip: the edge that has
          // tabs past it dissolves instead of clipping one mid-word, and the
          // fade is a third of a tab rather than the registry's 48px, which on a
          // 28px strip would have swallowed a whole one.
          //
          // `scrollbar-hide` for the same reason the command menu's filter row
          // has it: the bars are *classic* here (styles.css restyles
          // `::-webkit-scrollbar` under `@media (pointer: fine)`, which opts out
          // of the overlay ones), so each reserves 10px of a 28px strip. And
          // `overflow-x: auto` makes the other axis a scroller too, which the
          // trigger's `after:` underline — `bottom-[-5px]`, invisible in this
          // variant — overflows by 3px: enough for a vertical bar nobody asked
          // for, whose gutter drew 11px of `bg-muted` past the last tab.
          className="scroll-fade-x scrollbar-hide max-w-full justify-start gap-0.5 overflow-x-auto [--scroll-fade-size:20px]"
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
              onClose={onCloseTab}
              onNewTerminal={onNewTerminal}
              onSplit={onSplitTab}
            />
          ))}
        </TabsList>
      </Tabs>
      <div className="flex shrink-0 items-center gap-0.5">
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
        <Separator orientation="vertical" className="mx-0.5 h-4" />
        <Tooltip>
          <TooltipTrigger render={NEW_TERMINAL_BUTTON} onClick={onNewTerminal} />
          <TooltipContent>
            New Terminal <Kbd>⌘T</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </WindowBar>
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
  readonly onClose: (index: number) => void;
  readonly onNewTerminal: () => void;
  readonly onSplit: (index: number, axis: Axis) => void;
}): ReactElement {
  const { index, label, drag, onDrag, onDrop, onDragEnd, onClose, onNewTerminal, onSplit } = props;

  const handleClose = useCallback(() => {
    onClose(index);
  }, [index, onClose]);

  // Every row names *this* tab, which is the point: the strip's own buttons act
  // on the tab showing, and this is the one that was pointed at.
  const splitRight = useCallback(() => {
    onSplit(index, "horizontal");
  }, [index, onSplit]);
  const splitDown = useCallback(() => {
    onSplit(index, "vertical");
  }, [index, onSplit]);
  const menuRows = useMemo(
    () => tabMenuRows({ newTerminal: onNewTerminal, splitRight, splitDown, closeTab: handleClose }),
    [handleClose, onNewTerminal, splitDown, splitRight],
  );

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

  // The indicator draws on the tab the slot sits beside: its left edge for a slot
  // before it, its right edge for one after — in strip indices, with the dragged
  // tab still in place.
  const indicator = drag === undefined || drag.to === undefined ? undefined : dropEdge(drag, index);

  return (
    <ContextMenuRegion
      label={`Tab: ${label}`}
      rows={menuRows}
      className={cn(
        // `shrink-0`: with many tabs the strip *scrolls*, it does not squeeze.
        // Shrinking held the row to its width by clipping every tab's label over
        // the close button laid across it — and it made the horizontal fade
        // decoration, because 12 tabs overflowed by 30px instead of by ten
        // tabs' worth.
        "relative flex h-full min-w-0 shrink-0 items-center",
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
        // `pr-7` reserves the close button's room inside the pill: the button is
        // a *sibling* laid over that gap, never a child, because a tab is a
        // `<button>` and a button inside a button is not markup a browser keeps.
        className="max-w-48 min-w-0 flex-none pr-7 pl-2"
      >
        <span className="truncate">{label}</span>
      </TabsTrigger>
      {/* Always drawn, at two-thirds opacity rather than appearing on hover: a
          control that is invisible until pointed at cannot be found by someone
          who does not already know it is there, and a tab has room for it. */}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Close tab: ${label}`}
        onClick={handleClose}
        className="absolute right-0.5 size-5 opacity-65 hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-3"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </ContextMenuRegion>
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
  <Button variant="ghost" size="icon-sm" aria-label="New Terminal">
    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_VERTICALLY_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Split Vertically">
    <HugeiconsIcon icon={LayoutTwoColumnIcon} strokeWidth={2} />
  </Button>
);

const SPLIT_HORIZONTALLY_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Split Horizontally">
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
  readonly onClosePane: (id: TerminalID) => void;
  /** Splits *this* pane, which is not always the focused one. */
  readonly onSplitPane: (id: TerminalID, axis: Axis) => void;
  readonly onNewTerminal: () => void;
}

/**
 * The split tree, rendered. Bounded by `MAXIMUM_PANE_DEPTH` upstream.
 *
 * ## How a split moves
 *
 * The sized half's `flex-basis` eases to its new value, except while the divider
 * is under the pointer — the model motion-panels demonstrates, and the only one
 * that is right in both directions: a drag must track the finger exactly, and a
 * split arriving from the daemon (or ⌘D, or a pane closing) should be seen to
 * happen rather than teleport. A CSS transition, so an interrupted drag is picked
 * up mid-flight instead of fighting an animation that owns the value.
 *
 * `will-change` is deliberately absent: the panes below are terminals, and
 * promoting a layer that holds a canvas costs more than the 200ms it would
 * smooth.
 */
function PaneView(props: PaneViewProps): ReactElement {
  const { pane, path } = props;

  const [isResizing, setResizing] = useState(false);

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
        onClose={props.onClosePane}
        onSplit={props.onSplitPane}
        onNewTerminal={props.onNewTerminal}
      />
    );
  }

  // `horizontal` divides side by side, so the box is a row and the divider is
  // vertical — see the `Axis` doc comment in @janela/core.
  const isRow = pane.axis === "horizontal";
  return (
    <div className={`flex h-full w-full ${isRow ? "flex-row" : "flex-col"}`}>
      <div
        style={firstStyle}
        className={cn(
          "min-h-0 min-w-0 shrink-0 grow-0",
          !isResizing &&
            "motion-safe:transition-[flex-basis] motion-safe:duration-(--spring-moderate) ease-out",
        )}
      >
        <PaneView {...props} pane={pane.first} path={firstPath} />
      </div>
      <Divider
        axis={pane.axis}
        fraction={pane.fraction}
        path={path}
        onFraction={props.onFraction}
        onResizingChange={setResizing}
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
 * The gap between two panes, which is also the handle that moves it.
 *
 * A real `<input type="range">` rather than a div with `role="separator"`: a
 * window splitter *is* a value in a range, and the browser then supplies keyboard
 * adjustment, the value, and the announcement for free. Arrow keys shadow nothing
 * — a divider is not a terminal — and no `Ctrl` chord is bound here or anywhere
 * else in this package.
 *
 * It paints **nothing**: the 6px it occupies is the spacing between two rounded
 * panes, and a line drawn down the middle of a gap that is already a gap is one
 * more edge to look at. The cursor says it is draggable, and a faint bar appears
 * under the pointer — the motion-panels grip, which is discovered by aiming at
 * the seam rather than by being outlined all the time.
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
  /** While true, the sized pane follows the pointer instead of easing. */
  readonly onResizingChange: (isResizing: boolean) => void;
}): ReactElement {
  const { axis, fraction, path, onFraction, onResizingChange } = props;

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

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      // The native drag would map the pointer to this 6px-wide box and jump the
      // value to an end. The move handler measures the split instead — but the
      // element still has to take focus, which `preventDefault` would have
      // stopped.
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      onResizingChange(true);
    },
    [onResizingChange],
  );

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

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      onResizingChange(false);
    },
    [onResizingChange],
  );

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
      // `bg-clip-content` with 2px of padding: the box is 6px of spacing and the
      // grip it paints on hover is the 2px in the middle of it.
      //
      // The thumb is hidden explicitly. `appearance-none` removes the track's own
      // chrome and leaves the thumb, which Chromium then draws as a 16px lozenge
      // across a 6px gap — a control this element is not: the whole seam is the
      // handle, and the pointer is already captured by `handlePointerDown`.
      className={`hover:bg-ring/50 focus-visible:bg-ring active:bg-ring/60 m-0 shrink-0 appearance-none bg-transparent bg-clip-content transition-colors duration-(--spring-fast) [&::-moz-range-thumb]:hidden [&::-webkit-slider-thumb]:hidden ${
        axis === "horizontal"
          ? "h-full w-1.5 cursor-col-resize px-[2px]"
          : "h-1.5 w-full cursor-row-resize py-[2px]"
      }`}
    />
  );
}

/**
 * One attached terminal, under a bar carrying its name.
 *
 * Mounted only for the focused tab: an unfocused tab renders nothing, attaches
 * nothing and costs nothing, which is the laziness rule applied to the surface
 * that costs the most (AGENTS.md § Non-negotiables 5).
 *
 * ## Why a terminal has a bar of its own
 *
 * A terminal is not a tab. A tab is an arrangement — a pane tree — and the same
 * terminal is meant to be draggable into a different one without stopping, which
 * is only coherent if the thing being moved is visible and named where it lives.
 * The bar is where that name is, where closing *this* terminal is, and where the
 * grab handle goes when moving one is built (#35 territory: the daemon owns the
 * layout, so a move is a request, not a local edit).
 *
 * It costs a row of the grid, which is the reason it says as little as possible:
 * the name, the state when the state is not "running", and one button.
 */
function TerminalPane(props: {
  readonly terminalID: TerminalID;
  readonly descriptor: TerminalDescriptor | undefined;
  readonly state: TerminalState | undefined;
  readonly isFocused: boolean;
  readonly connection: DaemonConnection;
  readonly isConnected: boolean;
  readonly onFocusTerminal: (id: TerminalID) => void;
  readonly onClose: (id: TerminalID) => void;
  readonly onSplit: (id: TerminalID, axis: Axis) => void;
  readonly onNewTerminal: () => void;
}): ReactElement {
  const {
    terminalID,
    descriptor,
    state,
    isFocused,
    connection,
    isConnected,
    onFocusTerminal,
    onClose,
    onSplit,
    onNewTerminal,
  } = props;

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

  const handleClose = useCallback(() => {
    onClose(terminalID);
  }, [onClose, terminalID]);

  // Built when the menu opens rather than on every render, because the one fact
  // that decides a row's availability is not in React: whether this terminal has
  // a selection lives in the emulator. Reading it in the open handler is reading
  // it at the moment of the gesture, which is the only moment that matters — and
  // it keeps every `handleRef` read out of the render path.
  const [menuRows, setMenuRows] = useState<readonly MenuRow[]>(NO_MENU_ROWS);
  const clipboard = environment.clipboard;
  const buildMenu = useCallback(() => {
    setMenuRows(
      terminalMenuRows({
        hasSelection: handleRef.current?.selectedText() !== undefined,
        copy: () => {
          const selection = handleRef.current?.selectedText();
          if (selection !== undefined) void clipboard.copy(selection);
        },
        paste: () => {
          // Through the surface rather than `sendInput`: the emulator is what
          // knows whether the program asked for bracketed paste.
          void clipboard.paste().then((text) => {
            if (text !== undefined) handleRef.current?.paste(text);
            return undefined;
          });
        },
        clear: () => handleRef.current?.clearViewport(),
        splitRight: () => onSplit(terminalID, "horizontal"),
        splitDown: () => onSplit(terminalID, "vertical"),
        newTerminal: onNewTerminal,
        close: handleClose,
      }),
    );
  }, [clipboard, handleClose, onNewTerminal, onSplit, terminalID]);

  const title = descriptor?.title ?? "Terminal";
  const stateText = terminalStateText(state);
  const size = useSize();

  return (
    // No focus treatment, and that is a decision: a pane is focused because the
    // user just clicked or typed in it, the caret in it blinks, and the output
    // answers. An outline, glow or tinted background on top of that is a fourth
    // signal for something nobody was confused about — and with two panes open it
    // draws a box around half the window. `onFocusCapture` still records the
    // focus, because ⌘D, ⌘W and the notification click all act on it.
    //
    // `rounded-lg` here rather than on the surface: this box clips xterm, whose
    // own element is square and whose scrollbar would otherwise sit in the corner.
    //
    // The pane is what is elevated, not a container behind it: `shadow-surface-2`
    // is level 2 of the surface ladder's shadow half, over a window that is level
    // 1. That is one hairline plus a shallow drop in the light appearance, and an
    // inset hairline with a top highlight in the dark one — which is what an edge
    // has to be here, because in light the terminal background and the window's
    // are both near-white and two panes side by side would otherwise be one field
    // with an invisible 6px gap in it. It is structure, identical on every pane
    // whatever its state.
    //
    // A pane appearing is the largest thing that moves here, so the enter takes
    // the `slow` tier of the motion ladder — `--spring-slow`, the CSS half of
    // `spring.slow`. `transition-none` because `duration-*` sets the transition
    // duration too, and a pane has nothing it wants to transition: left alone,
    // an appearance switch would cross-fade its edge and background.
    <div
      // The identity of a pane in the markup, the way every `@janela/design`
      // component names its parts: what a test scopes an assertion to, and what
      // a drag of a terminal between tabs will have to hit.
      data-slot="terminal-pane"
      onFocusCapture={handleFocusCapture}
      className="bg-terminal-background shadow-surface-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 flex h-full w-full flex-col overflow-hidden rounded-lg transition-none motion-safe:duration-(--spring-slow)"
    >
      {/* The divider under the bar separates two things and says nothing about
          either of them, so it is a hairline of the same weight as the pane's own
          edge — 8% of pure black or white, never a tinted neutral, which would
          pick up the surface under it and read as dirt. */}
      <div
        className={cn(
          size.control,
          "flex shrink-0 items-center gap-1.5 border-b border-[oklch(0_0_0/0.08)] pr-0.5 pl-2 dark:border-[oklch(1_0_0/0.08)]",
        )}
      >
        <span className="text-foreground/70 min-w-0 flex-1 truncate text-xs font-medium">
          {title}
        </span>
        {state?.kind === "running" ? null : (
          <Badge variant={isFailureState(state) ? "destructive" : "secondary"}>{stateText}</Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Close terminal: ${title}`}
          onClick={handleClose}
          className="size-5 shrink-0 opacity-65 hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-3"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      {/* The menu is on the terminal itself rather than the whole pane: the bar
          above carries its own controls, and a right-click on a title is a
          right-click on the bar. `contents` so the region adds no box to the
          grid — the surface still fills the pane. */}
      <ContextMenuRegion
        label={`Terminal: ${title}`}
        rows={menuRows}
        onOpen={buildMenu}
        className="relative min-h-0 flex-1"
      >
        <TerminalSurface
          ref={registerSurface}
          label={`Terminal: ${title} — ${stateText}`}
          focused={isFocused}
          onInput={handleInput}
          onViewportChange={handleViewportChange}
        />
      </ContextMenuRegion>
    </div>
  );
}

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
