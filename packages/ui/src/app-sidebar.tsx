import {
  ArrowRight01Icon,
  ComputerTerminal01Icon,
  FilterIcon,
  FolderAddIcon,
  InboxIcon,
  PlusSignIcon,
  Search01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Project, ProjectID, Session, SessionID } from "@janela/core";
import {
  Badge,
  Button,
  cn,
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownTrigger,
  Empty,
  MenuItem,
  EmptyDescription,
  hugeicon,
  Kbd,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useSize,
  type IconComponent,
  type IconComponentProps,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { selectSession } from "./command-dispatch.ts";
import type { CommandID } from "./commands.ts";
import { ContextMenuRegion } from "./context-menu-region.tsx";
import { projectMenuRows, sessionMenuRows } from "./menu-rows.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { createSidebarActions, type SidebarActions } from "./sidebar-actions.ts";
import {
  filterSidebar,
  mergedExpansions,
  SESSION_FILTER_TITLE,
  SESSION_FILTERS,
  type SessionFilter,
} from "./sidebar-filter.ts";
import { sidebarRows, statusText, type SessionStatus, type SidebarRow } from "./sidebar-model.ts";
import { SIDEBAR_SCROLLER, WindowControlsRoom } from "./window-chrome.tsx";

/**
 * Projects and sessions, and the only navigation there is.
 *
 * ```text
 * ┌──────────────────────────────┐
 * │ ● ● ●             [⌕]  [▤]   │  ← header: never scrolls
 * │ ＋ New Session               │
 * │ ⌧ Inbox            Planned   │
 * ├──────────────────────────────┤
 * │ Sessions          [⌥] [＋]   │  ← content: scrolls on its own
 * │  • scratch                   │
 * │ ▼ ▣ janela              [+]  │  ← [+] on hover: a session here
 * │    • main                    │
 * │    • fix/pty  ●              │
 * │ ▸ ▣ api                      │
 * ├──────────────────────────────┤
 * │ ⚙ Settings                   │  ← footer: never scrolls
 * └──────────────────────────────┘
 * ```
 *
 * ## Two levels, and never a third
 *
 * `sidebarRows` returns a **flat** array: standalone sessions, then each project
 * followed by its sessions. The flatness is the point — a recursive row type
 * would quietly permit a third level, and two is a product decision (AGENTS.md
 * § Non-negotiables 2). Session rows are indented by class, not by nesting.
 *
 * One group, headed **Sessions**, holds every row: a session is the thing this
 * list is a list of, and a project is where some of them come from. A standalone
 * session and a project's session are the same row under the same heading; the
 * project is the indentation, not a second section.
 *
 * ## Two ways in, and two ways to make one
 *
 * The magnifier opens the Command Menu, which is where *finding* happens — this
 * list carries no search field of its own, because one query answered two
 * different ways is worse than one answer (`CommandPalette`). What stays here is
 * the status filter, which is a question about state rather than a search.
 *
 * Creating is one row and two buttons: **New Session** opens the one sheet, where
 * "No project" is a choice, the **＋** beside *Sessions* adds a project, and the
 * **+** on a project row starts a session inside that project.
 * A user who has added nothing yet is never told to go and find a menu.
 *
 * ## What scrolls, and what does not
 *
 * `SidebarHeader`, `SidebarContent` and `SidebarFooter` are siblings in a
 * column, and only the content has `overflow-auto`. So search, New Session, Inbox
 * and Settings stay reachable with two hundred sessions between them — which is
 * the case that makes those controls worth pinning in the first place.
 *
 * ## Expanding still does no work
 *
 * A click flips a boolean and reads nothing. A project that had to load anything
 * to expand would have broken the laziness rule upstream
 * (docs/performance.md § Interaction). The override is local: `Project.isExpanded`
 * is the mirror's value, and the only way to change *that* would be a protocol
 * message which does not exist (#35), so an override lasts as long as the window.
 *
 * ## Where the actions live
 *
 * Right-click is the primary affordance and the hover button is the shortcut for
 * the one action people take constantly. Both go through `SidebarActions`, so
 * the menu item and the button cannot drift apart, and neither can be tested only
 * by rendering a menu.
 */
export function AppSidebar(props: {
  /**
   * How a chosen command runs. Adding a project is a `CommandID`, not a request
   * of this view's own: the menu bar, the palette and the header button then open
   * the same directory dialog and send the same message.
   */
  readonly dispatch: (id: CommandID) => void;
}): ReactElement {
  const environment = useClientEnvironment();
  const projects = useStoreValue(environment.projects, () => environment.projects.projects);
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const selection = useStoreValue(environment.sessions, () => environment.sessions.selection);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);

  const size = useSize();
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [overrides, setOverrides] = useState(NO_OVERRIDES);

  const narrowed = useMemo(
    () => filterSidebar(filter, projects, sessions, states),
    [filter, projects, sessions, states],
  );
  const rows = useMemo(
    () =>
      sidebarRows(
        narrowed.projects,
        narrowed.sessions,
        states,
        mergedExpansions(overrides, narrowed.expansions),
      ),
    [narrowed, states, overrides],
  );

  const actions = useMemo(
    () =>
      createSidebarActions({
        sessions: environment.sessions,
        connection: environment.connection,
        view: environment.view,
        native: environment.native,
        confirmations: environment.confirmations,
      }),
    [environment],
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

  // A project always contributes a row, so an empty list means there is nothing
  // at all — or that the filter left nothing.
  const isEmpty = rows.length === 0;
  const isFiltered = filter !== "all";

  const { dispatch } = props;
  const search = useCallback(() => {
    dispatch("showCommands");
  }, [dispatch]);
  const newSession = useCallback(() => {
    dispatch("newSession");
  }, [dispatch]);
  const addProject = useCallback(() => {
    dispatch("addProject");
  }, [dispatch]);
  const openSettings = useCallback(() => {
    dispatch("openSettings");
  }, [dispatch]);

  const renderRow = (row: SidebarRow): ReactElement =>
    row.kind === "project" ? (
      <ProjectRow
        key={row.project.id}
        project={row.project}
        isExpanded={row.isExpanded}
        actions={actions}
        onToggle={toggle}
      />
    ) : (
      <SessionRow
        key={row.session.id}
        session={row.session}
        status={row.status}
        indented={row.indented}
        isSelected={row.session.id === selection}
        actions={actions}
        onSelect={select}
      />
    );

  return (
    // `inset`: the sidebar is the window's surface and the content sits on a
    // rounded card inside it (`SidebarInset`), which is what puts the terminals
    // on their own sheet rather than against the window frame.
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader>
        {/* One control tall: the ladder's step, so this row lines up with the
            rows beneath it and with the window bar across the card — and so the
            traffic lights, which are positioned against *this* row, land on its
            centre line (`TRAFFIC_LIGHT_POSITION`).

            What used to be here was the mark and the word "Janela". The window
            controls say the same thing in the place macOS puts them, and the
            remainder of the row is the band that drags the window, which is what
            a title bar was for. */}
        <div className={cn(size.control, "flex items-center gap-0.5")}>
          <WindowControlsRoom />
          <div className="flex-1" data-tauri-drag-region />
          <Tooltip>
            <TooltipTrigger render={SEARCH_BUTTON} onClick={search} />
            <TooltipContent>
              Search <Kbd>⌘⇧P</Kbd>
            </TooltipContent>
          </Tooltip>
          {/* No wrapping tooltip: the primitive's trigger carries its own, with
              the ⌘B chip in it. */}
          <SidebarTrigger />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              icon={PLUS_ICON}
              onClick={newSession}
              title="Start a session in a project, or in a folder of its own"
            >
              New Session
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Reserved: the row is here so the layout is final, and disabled so
                it promises nothing it cannot do yet. The badge says which kind of
                nothing — an item that is merely grey reads as broken. */}
            <SidebarMenuButton
              icon={INBOX_ICON}
              disabled
              aria-disabled="true"
              title="Inbox is not available yet"
            >
              Inbox
            </SidebarMenuButton>
            <SidebarMenuBadge className="px-0">
              <Badge variant="secondary" className="text-[0.625rem] tracking-wide uppercase">
                Planned
              </Badge>
            </SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className={SIDEBAR_SCROLLER}>
        <SidebarGroup className="py-1">
          {/* The label and its two actions share a row rather than the primitive's
              absolutely-positioned `SidebarGroupAction`, which holds one. */}
          <div className="flex items-center gap-0.5 pr-1">
            <SidebarGroupLabel className="flex-1">
              {isFiltered ? "Matches" : "Sessions"}
            </SidebarGroupLabel>
            <SessionFilterMenu filter={filter} onChange={setFilter} />
            <Tooltip>
              <TooltipTrigger render={NEW_PROJECT_BUTTON} onClick={addProject} />
              <TooltipContent>New Project</TooltipContent>
            </Tooltip>
          </div>
          <SidebarMenu>{rows.map(renderRow)}</SidebarMenu>
          {isEmpty ? <EmptyState isFiltered={isFiltered} /> : null}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton icon={SETTINGS_ICON} onClick={openSettings}>
              Settings
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* The rail is the primitive's: drag it to resize the sidebar, click it to
          collapse. It is `tabIndex={-1}` upstream, because it is a pointer
          shortcut for ⌘B, which already exists. */}
      <SidebarRail />
    </Sidebar>
  );
}

const NO_OVERRIDES: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

/**
 * A session's state, as the row's leading glyph.
 *
 * `SidebarMenuButton` reserves the icon column and hands its component the
 * ladder's glyph size, so the dot belongs there rather than in the label: a dot
 * passed as a child would sit inside the text box and stop the row's name from
 * being the weight-animated label. One component per state, built once at module
 * scope — an inline one would be a new component type on every render, which
 * remounts.
 *
 * Drawn as an `svg` rather than a sized `span` for the same reason every other
 * row glyph is one: the size arrives as a number, and an element that takes it
 * as an attribute needs no per-render style object.
 */
function dotIcon(tint: string, filled: boolean): IconComponent {
  return function StatusDot({ size = 14, className }: IconComponentProps) {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 14 14"
        // The tint last: `SidebarMenuButton` hands its icon the row's lit/unlit
        // text colour, and a session's state is not a hover state.
        className={cn("shrink-0", className, tint)}
      >
        <circle
          cx="7"
          cy="7"
          r={filled ? 3 : 2.5}
          fill={filled ? "currentColor" : "none"}
          stroke={filled ? "none" : "currentColor"}
        />
      </svg>
    );
  };
}

const STATUS_ICON: Record<SessionStatus, IconComponent> = {
  attention: dotIcon("text-attention", true),
  running: dotIcon("text-running", true),
  failed: dotIcon("text-failure", true),
  idle: dotIcon("text-muted-foreground", false),
};

const PLUS_ICON = hugeicon(PlusSignIcon);
const INBOX_ICON = hugeicon(InboxIcon);
const SETTINGS_ICON = hugeicon(Settings01Icon);
/** The project row's disclosure chevron. The row rotates it from its own
 *  `isExpanded`, so this stays one component and the rotation can animate. */
const CHEVRON_ICON = hugeicon(ArrowRight01Icon);

// MARK: - Header

/**
 * The header's controls and the group's two actions, as elements.
 *
 * Hoisted because `render` takes an element and `react-perf` forbids building one
 * in a prop — a fresh element every render would also remount the button the
 * primitive composes into.
 */
const SEARCH_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Search">
    <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
  </Button>
);

const NEW_PROJECT_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="New Project">
    <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
  </Button>
);

const FILTER_BUTTON_GHOST = (
  <Button variant="ghost" size="icon-sm">
    <HugeiconsIcon icon={FilterIcon} strokeWidth={2} />
  </Button>
);

const FILTER_BUTTON_SECONDARY = (
  <Button variant="secondary" size="icon-sm">
    <HugeiconsIcon icon={FilterIcon} strokeWidth={2} />
  </Button>
);

/**
 * Which sessions the list shows — a question about state, not a search.
 */
function SessionFilterMenu(props: {
  readonly filter: SessionFilter;
  readonly onChange: (filter: SessionFilter) => void;
}): ReactElement {
  const { filter, onChange } = props;

  return (
    <DropdownMenu>
      <DropdownTrigger
        aria-label={`Filter: ${SESSION_FILTER_TITLE[filter]}`}
        title={SESSION_FILTER_TITLE[filter]}
        // The trigger says whether the list is narrowed, so its variant is
        // state — hence two hoisted elements rather than one built per render.
        render={filter === "all" ? FILTER_BUTTON_GHOST : FILTER_BUTTON_SECONDARY}
      />
      {/* `checkedIndex` is what draws the picked row's own background and
          announces the radio value; the rows are numbered in the same order. */}
      <DropdownContent className="w-48" align="end" checkedIndex={SESSION_FILTERS.indexOf(filter)}>
        <DropdownLabel>Show</DropdownLabel>
        {SESSION_FILTERS.map((candidate, index) => (
          <FilterRow
            key={candidate}
            index={index}
            filter={candidate}
            isChecked={candidate === filter}
            onSelect={onChange}
          />
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

/**
 * One choice in the filter menu.
 *
 * Its own component so the row's handler belongs to the row: a `() =>
 * onChange(candidate)` written in the list would be a fresh function per filter
 * per render, and every row would re-render whenever any of them did.
 */
function FilterRow(props: {
  readonly index: number;
  readonly filter: SessionFilter;
  readonly isChecked: boolean;
  readonly onSelect: (filter: SessionFilter) => void;
}): ReactElement {
  const { index, filter, isChecked, onSelect } = props;

  const handleSelect = useCallback(() => {
    onSelect(filter);
  }, [filter, onSelect]);

  return (
    <MenuItem
      index={index}
      label={SESSION_FILTER_TITLE[filter]}
      checked={isChecked}
      // Base UI keeps a menu open after a radio pick, which is right for a menu
      // you set several things in and wrong for one that holds a single choice —
      // the list behind it is what you came to look at.
      closeOnClick
      onSelect={handleSelect}
    />
  );
}

// MARK: - Rows

function ProjectRow(props: {
  readonly project: Project;
  readonly isExpanded: boolean;
  readonly actions: SidebarActions;
  readonly onToggle: (id: ProjectID, wasExpanded: boolean) => void;
}): ReactElement {
  const { project, isExpanded, actions, onToggle } = props;

  const handleToggle = useCallback(() => {
    onToggle(project.id, isExpanded);
  }, [onToggle, project.id, isExpanded]);

  const newSession = useCallback(() => {
    actions.newSession(project.id);
  }, [actions, project.id]);

  const rows = useMemo(() => projectMenuRows(project, actions), [project, actions]);

  return (
    <SidebarMenuItem>
      {/* The trigger is a plain wrapper rather than the row itself, so the
          hover action stays a sibling of the button — `SidebarMenuAction`
          positions against the item and reveals on `group/menu-item` hover. */}
      <ContextMenuRegion label={`Project: ${project.name}`} rows={rows} className="block">
        <SidebarMenuButton
          icon={CHEVRON_ICON}
          aria-expanded={isExpanded}
          onClick={handleToggle}
          // The chevron is the row's only `svg`, so the row rotates it from
          // here: one icon component that stays mounted, and a rotation that
          // can animate. Swapping the component per state would remount it.
          className={cn(
            "font-medium [&>svg]:motion-safe:transition-transform",
            isExpanded && "[&>svg]:rotate-90",
          )}
        >
          <ProjectIcon project={project} />
          {project.name}
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
          aria-label={`New Session in ${project.name}`}
          title={`New Session in ${project.name}`}
          onClick={newSession}
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </SidebarMenuAction>
      </ContextMenuRegion>
    </SidebarMenuItem>
  );
}

function SessionRow(props: {
  readonly session: Session;
  readonly status: SessionStatus;
  readonly indented: boolean;
  readonly isSelected: boolean;
  readonly actions: SidebarActions;
  readonly onSelect: (id: SessionID) => void;
}): ReactElement {
  const { session, status, indented, isSelected, actions, onSelect } = props;

  const handleSelect = useCallback(() => {
    onSelect(session.id);
  }, [onSelect, session.id]);

  const newTerminal = useCallback(() => {
    actions.newTerminal(session.id);
  }, [actions, session.id]);

  const rows = useMemo(() => sessionMenuRows(session, actions), [session, actions]);

  return (
    <SidebarMenuItem>
      <ContextMenuRegion label={`Session: ${session.name}`} rows={rows} className="block">
        <SidebarMenuButton
          icon={STATUS_ICON[status]}
          // The status is in the name, not only in the dot: a colour alone is a
          // state a screen reader cannot read and a colour-blind user cannot
          // distinguish.
          aria-label={`${session.name} — ${statusText(status)}`}
          aria-current={isSelected ? "true" : undefined}
          isActive={isSelected}
          onClick={handleSelect}
          className={indented ? "pl-7" : undefined}
        >
          {session.name}
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
          aria-label={`New Terminal in ${session.name}`}
          title={`New Terminal in ${session.name}`}
          onClick={newTerminal}
        >
          <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
        </SidebarMenuAction>
      </ContextMenuRegion>
    </SidebarMenuItem>
  );
}

/**
 * Nothing to show, and which nothing it is.
 *
 * Two sentences, because "this filter found nothing" and "you have not added
 * anything" call for different next actions — and an empty list with no sentence
 * at all reads as a broken one. Neither repeats the buttons above it.
 */
function EmptyState(props: { readonly isFiltered: boolean }): ReactElement {
  return (
    <Empty className="p-3">
      <EmptyDescription className="text-muted-foreground text-xs">
        {props.isFiltered
          ? "Nothing matches this filter."
          : "No sessions yet. Start one in any folder, or add a project."}
      </EmptyDescription>
    </Empty>
  );
}
