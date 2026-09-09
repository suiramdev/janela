import type { DaemonConnection } from "@janela/client";
import {
  emptyLayout,
  focusedTab,
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
import { createCommandDispatch, selectSession } from "./command-dispatch.ts";
import type { CommandID } from "./commands.ts";
import { ConnectionBanner } from "./connection-banner.tsx";
import {
  resolveLocalLayout,
  withFocusedTab,
  withFocusedTerminal,
  withSplitFraction,
  type PanePath,
} from "./layout-edits.ts";
import { SheetHost } from "./sheets.tsx";
import { sidebarRows, statusText, type SessionStatus } from "./sidebar-model.ts";

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

  const { view, commands, settings } = environment;

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
      <SheetHost dispatch={run} />
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

// MARK: - Sidebar

const STATUS_DOT: Record<SessionStatus, string> = {
  attention: "bg-attention",
  running: "bg-running",
  failed: "bg-failure",
  idle: "bg-transparent",
};

const NO_OVERRIDES: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

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
    view.openSheet({ kind: "profilePicker", sessionID });
  }, [view, sessionID]);

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
      <TabStrip
        layout={layout}
        terminals={terminals}
        onFocusTab={focusTab}
        onNewTerminal={newTerminal}
      />
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
 * The `+` is the only creation affordance in the window that is not also a menu
 * item — and it is the same action, opening the same picker ⌘T does.
 */
function TabStrip(props: {
  readonly layout: SessionLayout;
  readonly terminals: readonly TerminalDescriptor[];
  readonly onFocusTab: (index: number) => void;
  readonly onNewTerminal: () => void;
}): ReactElement | null {
  const { layout, terminals, onFocusTab, onNewTerminal } = props;
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
      <button
        type="button"
        aria-label="New Terminal"
        title="New Terminal ⌘T"
        onClick={onNewTerminal}
        className="rounded-small px-2 py-1 text-xs hover:bg-black/5"
      >
        +
      </button>
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
