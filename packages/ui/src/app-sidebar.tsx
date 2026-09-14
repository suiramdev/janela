import {
  Cancel01Icon,
  ArrowRight01Icon,
  ComputerTerminal01Icon,
  Delete02Icon,
  FilterIcon,
  FolderAddIcon,
  FolderOpenIcon,
  GitBranchIcon,
  InboxIcon,
  PlusSignIcon,
  Settings01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  supportsWorktrees,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
} from "@janela/core";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@janela/design";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import { selectSession } from "./command-dispatch.ts";
import type { CommandID } from "./commands.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { createSidebarActions, type SidebarActions } from "./sidebar-actions.ts";
import {
  EVERYTHING,
  filterSidebar,
  isNarrowed,
  mergedExpansions,
  SESSION_FILTER_TITLE,
  SESSION_FILTERS,
  type SessionFilter,
  type SidebarQuery,
} from "./sidebar-filter.ts";
import { sidebarRows, statusText, type SessionStatus, type SidebarRow } from "./sidebar-model.ts";

/**
 * Projects and sessions, and the only navigation there is.
 *
 * ```text
 * ┌──────────────────────────────┐
 * │ [ search…        ] [filter]  │  ← header: never scrolls
 * │ ⌧ Inbox                      │
 * ├──────────────────────────────┤
 * │ Sessions                     │  ← content: scrolls on its own
 * │  • scratch                   │
 * │ Projects                [+]  │
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
 * § Non-negotiables 2). Session rows are indented by class, not by nesting. The
 * standalone sessions get a group of their own above Projects only because a
 * heading that says "Projects" over a row that has none would be a lie; the
 * rows are the same rows.
 *
 * ## What scrolls, and what does not
 *
 * `SidebarHeader`, `SidebarContent` and `SidebarFooter` are siblings in a
 * column, and only the content has `overflow-auto`. So search, filter, Inbox and
 * Settings stay reachable with two hundred sessions between them — which is the
 * case that makes those controls worth pinning in the first place.
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

  const [query, setQuery] = useState(EVERYTHING);
  const [overrides, setOverrides] = useState(NO_OVERRIDES);

  const narrowed = useMemo(
    () => filterSidebar(query, projects, sessions, states),
    [query, projects, sessions, states],
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
  // at all — or that the query matched nothing.
  const isEmpty = rows.length === 0;
  const { standalone, projectRows } = useMemo(() => partitionRows(rows), [rows]);

  const addProject = useCallback(() => {
    props.dispatch("addProject");
  }, [props]);
  const openSettings = useCallback(() => {
    props.dispatch("openSettings");
  }, [props]);

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
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-sidebar-border gap-1 border-b">
        <SidebarQueryControls query={query} onChange={setQuery} />
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Reserved: the row is here so the layout is final, and disabled so
                it promises nothing it cannot do yet. */}
            <SidebarMenuButton
              size="sm"
              disabled
              aria-disabled="true"
              title="Inbox is not available yet"
            >
              <HugeiconsIcon icon={InboxIcon} strokeWidth={2} />
              <span>Inbox</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {standalone.length > 0 ? (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel>Sessions</SidebarGroupLabel>
            <SidebarMenu>{standalone.map(renderRow)}</SidebarMenu>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="py-1">
          <SidebarGroupLabel>{isNarrowed(query) ? "Matches" : "Projects"}</SidebarGroupLabel>
          <Tooltip>
            <TooltipTrigger
              render={NEW_PROJECT_ACTION}
              onClick={addProject}
              aria-label="New Project"
            />
            <TooltipContent>New Project</TooltipContent>
          </Tooltip>
          <SidebarMenu>{projectRows.map(renderRow)}</SidebarMenu>
          {isEmpty ? <EmptyState isNarrowed={isNarrowed(query)} /> : null}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" onClick={openSettings}>
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      {/* Drag the edge, or ⌘B. The rail is `tabIndex={-1}` upstream: it is a
          pointer shortcut for a keyboard action that already exists. */}
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Standalone sessions first, then everything from the first project on.
 *
 * The rows are already in that order; this only finds where the projects start,
 * so the two groups can carry different headings.
 */
export function partitionRows(rows: readonly SidebarRow[]): {
  readonly standalone: readonly SidebarRow[];
  readonly projectRows: readonly SidebarRow[];
} {
  const firstProject = rows.findIndex((row) => row.kind === "project");
  if (firstProject === -1) return { standalone: rows, projectRows: [] };
  return { standalone: rows.slice(0, firstProject), projectRows: rows.slice(firstProject) };
}

const NO_OVERRIDES: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

const STATUS_DOT: Record<SessionStatus, string> = {
  attention: "bg-attention",
  running: "bg-running",
  failed: "bg-failure",
  idle: "bg-transparent ring-1 ring-inset ring-sidebar-foreground/25",
};

// MARK: - Header

/**
 * Search and filter — the two controls that must survive scrolling.
 */
function SidebarQueryControls(props: {
  readonly query: SidebarQuery;
  readonly onChange: (query: SidebarQuery) => void;
}): ReactElement {
  const { query, onChange } = props;

  const handleText = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...query, text: event.target.value });
    },
    [onChange, query],
  );

  const handleFilter = useCallback(
    (value: unknown) => {
      onChange({ ...query, filter: value as SessionFilter });
    },
    [onChange, query],
  );

  const clear = useCallback(() => {
    onChange(EVERYTHING);
  }, [onChange]);

  return (
    <div className="flex items-center gap-1">
      {/* A real label, hidden: a search field whose only label is its
          placeholder is unlabelled the moment the user types. */}
      <label className="sr-only" htmlFor={SEARCH_FIELD_ID}>
        Search projects and sessions
      </label>
      <SidebarInput
        id={SEARCH_FIELD_ID}
        type="search"
        value={query.text}
        onChange={handleText}
        placeholder="Search…"
        className="h-7"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Filter: ${SESSION_FILTER_TITLE[query.filter]}`}
          title={SESSION_FILTER_TITLE[query.filter]}
          // The trigger says whether the list is narrowed, so its variant is
          // state — hence two hoisted elements rather than one built per render.
          render={query.filter === "all" ? FILTER_BUTTON_GHOST : FILTER_BUTTON_SECONDARY}
        />
        <DropdownMenuContent className="w-48" align="end">
          <DropdownMenuRadioGroup value={query.filter} onValueChange={handleFilter}>
            <DropdownMenuLabel>Show</DropdownMenuLabel>
            {SESSION_FILTERS.map((filter) => (
              // `closeOnClick`: Base UI keeps a menu open after a radio pick,
              // which is right for a menu you set several things in and wrong
              // for one that holds a single choice — the list behind it is
              // what you came to look at.
              <DropdownMenuRadioItem key={filter} value={filter} closeOnClick>
                {SESSION_FILTER_TITLE[filter]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {isNarrowed(query) ? (
        <Tooltip>
          <TooltipTrigger render={CLEAR_QUERY_BUTTON} onClick={clear} />
          <TooltipContent>Clear</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * The header's controls and the group's action, as elements.
 *
 * Hoisted because `render` takes an element and `react-perf` forbids building one
 * in a prop — a fresh element every render would also remount the button the
 * primitive composes into.
 */
const NEW_PROJECT_ACTION = (
  <SidebarGroupAction>
    <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
  </SidebarGroupAction>
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

const CLEAR_QUERY_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Clear search and filter">
    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
  </Button>
);

const SEARCH_FIELD_ID = "janela-sidebar-search";

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

  const newBranchSession = useCallback(() => {
    actions.newBranchSession(project.id);
  }, [actions, project.id]);

  const openSettings = useCallback(() => {
    actions.openProjectSettings(project.id);
  }, [actions, project.id]);

  const reveal = useCallback(() => {
    actions.revealInFinder(project.directory);
  }, [actions, project.directory]);

  const openInTerminal = useCallback(() => {
    actions.openInTerminal(project.directory);
  }, [actions, project.directory]);

  const remove = useCallback(() => {
    actions.removeProject(project);
  }, [actions, project]);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        {/* The trigger is a plain wrapper rather than the row itself, so the
            hover action stays a sibling of the button — `SidebarMenuAction`
            positions against the item and reveals on `group/menu-item` hover. */}
        <ContextMenuTrigger className="block">
          <SidebarMenuButton
            size="sm"
            aria-expanded={isExpanded}
            onClick={handleToggle}
            className="font-medium"
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              aria-hidden="true"
              className={`text-sidebar-foreground/50 shrink-0 motion-safe:transition-transform ${
                isExpanded ? "rotate-90" : ""
              }`}
            />
            <ProjectIcon project={project} />
            <span className="truncate">{project.name}</span>
          </SidebarMenuButton>
          <SidebarMenuAction
            showOnHover
            aria-label={`New Session in ${project.name}`}
            title={`New Session in ${project.name}`}
            onClick={newSession}
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          </SidebarMenuAction>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>{project.name}</ContextMenuLabel>
            <ContextMenuItem onClick={newSession}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              New Session…
            </ContextMenuItem>
            <ContextMenuItem onClick={newBranchSession} disabled={!supportsWorktrees(project)}>
              <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />
              New Branch Session…
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem onClick={reveal}>
              <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem onClick={openInTerminal}>
              <HugeiconsIcon icon={TerminalIcon} strokeWidth={2} />
              Open in Terminal
            </ContextMenuItem>
            <ContextMenuItem onClick={openSettings}>
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
              Project Settings…
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem variant="destructive" onClick={remove}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Remove Project…
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
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

  const reveal = useCallback(() => {
    actions.revealInFinder(session.directory);
  }, [actions, session.directory]);

  const openInTerminal = useCallback(() => {
    actions.openInTerminal(session.directory);
  }, [actions, session.directory]);

  const remove = useCallback(() => {
    actions.removeSession(session);
  }, [actions, session]);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger className="block">
          <SidebarMenuButton
            size="sm"
            // The status is in the name, not only in the dot: a colour alone is a
            // state a screen reader cannot read and a colour-blind user cannot
            // distinguish.
            aria-label={`${session.name} — ${statusText(status)}`}
            aria-current={isSelected ? "true" : undefined}
            isActive={isSelected}
            onClick={handleSelect}
            className={indented ? "pl-7" : undefined}
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
            />
            <span className="truncate">{session.name}</span>
          </SidebarMenuButton>
          <SidebarMenuAction
            showOnHover
            aria-label={`New Terminal in ${session.name}`}
            title={`New Terminal in ${session.name}`}
            onClick={newTerminal}
          >
            <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
          </SidebarMenuAction>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>{session.name}</ContextMenuLabel>
            <ContextMenuItem onClick={newTerminal}>
              <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
              New Terminal
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem onClick={reveal}>
              <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem onClick={openInTerminal}>
              <HugeiconsIcon icon={TerminalIcon} strokeWidth={2} />
              Open in Terminal
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem variant="destructive" onClick={remove}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Remove Session…
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  );
}

/**
 * Nothing to show, and which nothing it is.
 *
 * Two sentences, because "your search found nothing" and "you have not added
 * anything" call for different next actions — and an empty list with no sentence
 * at all reads as a broken one.
 */
function EmptyState(props: { readonly isNarrowed: boolean }): ReactElement {
  return (
    <Empty className="p-3">
      <EmptyDescription className="text-sidebar-foreground/60 text-xs">
        {props.isNarrowed
          ? "Nothing matches."
          : "No projects yet. Add a folder to start, or open one from the File menu."}
      </EmptyDescription>
    </Empty>
  );
}
