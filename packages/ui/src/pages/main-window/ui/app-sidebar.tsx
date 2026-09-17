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
  Dotm3x3_15,
  Dotm3x3_20,
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
  type Dotm3x3_20Props,
  type IconComponent,
  type IconComponentProps,
} from "@janela/design";
import type { ComponentType, ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import type { CommandID } from "../../../shared/config/index.ts";
import { useClientEnvironment, useStoreValue } from "../../../shared/model/index.ts";
import {
  ContextMenuRegion,
  ProjectIcon,
  SIDEBAR_SCROLLER,
  SidebarChromeHeader,
  SidebarTitleRow,
} from "../../../shared/ui/index.ts";
import { selectSession } from "../model/command-dispatch.ts";
import { projectMenuRows, sessionMenuRows } from "../model/menu-rows.ts";
import {
  type SessionStatus,
  type SidebarRow,
  sidebarRows,
  statusText,
} from "../model/session-rows.ts";
import { type SidebarActions, createSidebarActions } from "../model/sidebar-actions.ts";
import {
  SESSION_FILTERS,
  SESSION_FILTER_TITLE,
  type SessionFilter,
  filterSidebar,
  mergedExpansions,
} from "../model/sidebar-filter.ts";

const NO_OVERRIDES: ReadonlyMap<ProjectID, boolean> = new Map<ProjectID, boolean>();

const STATUS_ICON = {
  attention: statusGlyph(Dotm3x3_15, "text-attention", true),
  working: statusGlyph(Dotm3x3_20, "text-muted-foreground", true),
  failed: statusGlyph(Dotm3x3_15, "text-failure", true),
  running: statusGlyph(Dotm3x3_20, "invisible", false),
  idle: statusGlyph(Dotm3x3_20, "invisible", false),
} satisfies Record<SessionStatus, IconComponent>;

const PLUS_ICON = hugeicon(PlusSignIcon);

const INBOX_ICON = hugeicon(InboxIcon);

const SETTINGS_ICON = hugeicon(Settings01Icon);

const CHEVRON_ICON = hugeicon(ArrowRight01Icon);

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

export function AppSidebar(props: { readonly dispatch: (id: CommandID) => void }): ReactElement {
  const environment = useClientEnvironment();
  const projects = useStoreValue(environment.projects, () => environment.projects.projects);
  const sessions = useStoreValue(environment.sessions, () => environment.sessions.sessions);
  const selection = useStoreValue(environment.sessions, () => environment.sessions.selection);
  const states = useStoreValue(environment.sessions, () => environment.sessions.terminalStates);

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
        local: environment.local,
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
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarChromeHeader>
        <SidebarTitleRow>
          <div className="flex-1 self-stretch" />
          <Tooltip>
            <TooltipTrigger render={SEARCH_BUTTON} onClick={search} />
            <TooltipContent>
              Search <Kbd>⌘⇧P</Kbd>
            </TooltipContent>
          </Tooltip>
          <SidebarTrigger />
        </SidebarTitleRow>
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
      </SidebarChromeHeader>

      <SidebarContent className={SIDEBAR_SCROLLER}>
        <SidebarGroup className="py-1">
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

      <SidebarRail />
    </Sidebar>
  );
}

function statusGlyph(
  Loader: ComponentType<Dotm3x3_20Props>,
  tint: string,
  animated: boolean,
): IconComponent {
  return function StatusGlyph({ size = 14, className }: IconComponentProps) {
    return (
      <span aria-hidden="true" className={cn("inline-flex shrink-0", className, tint)}>
        <Loader size={size} boxSize={size} minSize={size} animated={animated} />
      </span>
    );
  };
}

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
        render={filter === "all" ? FILTER_BUTTON_GHOST : FILTER_BUTTON_SECONDARY}
      />
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
      closeOnClick
      onSelect={handleSelect}
    />
  );
}

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
      <ContextMenuRegion label={`Project: ${project.name}`} rows={rows} className="block">
        <SidebarMenuButton
          icon={CHEVRON_ICON}
          aria-expanded={isExpanded}
          onClick={handleToggle}
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
