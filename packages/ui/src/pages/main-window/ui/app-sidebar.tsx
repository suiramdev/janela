import {
  ArrowRight01Icon,
  ComputerIcon,
  FilterIcon,
  FolderAddIcon,
  InboxIcon,
  Moon02Icon,
  PlusSignIcon,
  Search01Icon,
  Settings01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Project, ProjectID, SessionID } from "@janela/core";
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
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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
import {
  THEME_PREFERENCES,
  THEME_TITLE,
  type ThemePreference,
  useClientEnvironment,
  useStoreValue,
  withTheme,
} from "../../../shared/model/index.ts";
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
  type SessionRow,
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
  error: statusGlyph(Dotm3x3_15, "text-failure", false),
  running: statusGlyph(Dotm3x3_20, "text-muted-foreground", true),
  unread: statusGlyph(Dotm3x3_15, "text-attention", true),
  idle: statusGlyph(Dotm3x3_20, "invisible", false),
} satisfies Record<SessionStatus, IconComponent>;

const PLUS_ICON = hugeicon(PlusSignIcon);

const INBOX_ICON = hugeicon(InboxIcon);

const SETTINGS_ICON = hugeicon(Settings01Icon);

const ChevronIcon = hugeicon(ArrowRight01Icon);

const SEARCH_BUTTON = (
  <Button variant="ghost" size="icon-sm" aria-label="Search">
    <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
  </Button>
);

const NEW_PROJECT_ACTION = (
  <SidebarGroupAction aria-label="New Project">
    <HugeiconsIcon icon={FolderAddIcon} />
  </SidebarGroupAction>
);

const FILTER_ACTION = (
  <SidebarGroupAction>
    <HugeiconsIcon icon={FilterIcon} />
  </SidebarGroupAction>
);

const FILTER_ACTION_NARROWED = (
  <SidebarGroupAction className="bg-secondary text-foreground">
    <HugeiconsIcon icon={FilterIcon} />
  </SidebarGroupAction>
);

const THEME_BUTTON = {
  system: (
    <Button variant="ghost" size="icon-sm">
      <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
    </Button>
  ),
  light: (
    <Button variant="ghost" size="icon-sm">
      <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />
    </Button>
  ),
  dark: (
    <Button variant="ghost" size="icon-sm">
      <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
    </Button>
  ),
} satisfies Record<ThemePreference, ReactElement>;

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

  const theme = useStoreValue(environment.view, () => environment.view.settings.theme);

  const changeTheme = useCallback(
    (next: ThemePreference) => {
      const settings = withTheme(environment.view.settings, next);

      environment.view.setSettings(settings);
      void environment.settings.save(settings).catch(() => undefined);
    },
    [environment],
  );

  const renderRow = (row: SidebarRow): ReactElement =>
    row.kind === "project" ? (
      <ProjectRow
        key={row.project.id}
        project={row.project}
        isExpanded={row.isExpanded}
        sessions={row.sessions}
        selection={selection}
        actions={actions}
        onToggle={toggle}
        onSelect={select}
      />
    ) : (
      <SessionRow
        key={row.session.id}
        row={row}
        nested={false}
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
        <SidebarGroup collapsible>
          <SidebarGroupLabel>{isFiltered ? "Matches" : "Sessions"}</SidebarGroupLabel>
          <SidebarGroupActions>
            <SessionFilterMenu filter={filter} onChange={setFilter} />
            <Tooltip>
              <TooltipTrigger render={NEW_PROJECT_ACTION} onClick={addProject} />
              <TooltipContent>New Project</TooltipContent>
            </Tooltip>
          </SidebarGroupActions>
          <SidebarMenu>{rows.map(renderRow)}</SidebarMenu>
          {isEmpty ? <EmptyState isFiltered={isFiltered} /> : null}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton icon={SETTINGS_ICON} onClick={openSettings}>
                Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {environment.local === undefined ? undefined : (
            <ThemeMenu theme={theme} onChange={changeTheme} />
          )}
        </div>
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
        render={filter === "all" ? FILTER_ACTION : FILTER_ACTION_NARROWED}
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

function ThemeMenu(props: {
  readonly theme: ThemePreference;
  readonly onChange: (theme: ThemePreference) => void;
}): ReactElement {
  const { theme, onChange } = props;

  return (
    <DropdownMenu>
      <DropdownTrigger
        aria-label={`Theme: ${THEME_TITLE[theme]}`}
        title={`Theme: ${THEME_TITLE[theme]}`}
        render={THEME_BUTTON[theme]}
      />
      <DropdownContent className="w-40" align="end" checkedIndex={THEME_PREFERENCES.indexOf(theme)}>
        <DropdownLabel>Theme</DropdownLabel>
        {THEME_PREFERENCES.map((candidate, index) => (
          <ThemeRow
            key={candidate}
            index={index}
            theme={candidate}
            isChecked={candidate === theme}
            onSelect={onChange}
          />
        ))}
      </DropdownContent>
    </DropdownMenu>
  );
}

function ThemeRow(props: {
  readonly index: number;
  readonly theme: ThemePreference;
  readonly isChecked: boolean;
  readonly onSelect: (theme: ThemePreference) => void;
}): ReactElement {
  const { index, theme, isChecked, onSelect } = props;

  const handleSelect = useCallback(() => {
    onSelect(theme);
  }, [theme, onSelect]);

  return (
    <MenuItem
      index={index}
      label={THEME_TITLE[theme]}
      checked={isChecked}
      closeOnClick
      onSelect={handleSelect}
    />
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

function projectGlyph(project: Pick<Project, "name" | "directory">): IconComponent {
  return function ProjectGlyph({ className }: IconComponentProps) {
    return <ProjectIcon project={project} className={className} />;
  };
}

function ProjectRow(props: {
  readonly project: Project;
  readonly isExpanded: boolean;
  readonly sessions: readonly SessionRow[];
  readonly selection: SessionID | undefined;
  readonly actions: SidebarActions;
  readonly onToggle: (id: ProjectID, wasExpanded: boolean) => void;
  readonly onSelect: (id: SessionID) => void;
}): ReactElement {
  const { project, isExpanded, sessions, selection, actions, onToggle, onSelect } = props;
  const { name, directory } = project;

  const handleToggle = useCallback(() => {
    onToggle(project.id, isExpanded);
  }, [onToggle, project.id, isExpanded]);

  const newSession = useCallback(() => {
    actions.newSession(project.id);
  }, [actions, project.id]);

  const rows = useMemo(() => projectMenuRows(project, actions), [project, actions]);

  const glyph = useMemo(() => projectGlyph({ name, directory }), [name, directory]);

  return (
    <SidebarMenuItem>
      <ContextMenuRegion label={`Project: ${project.name}`} rows={rows} className="block">
        <SidebarMenuButton
          icon={glyph}
          aria-expanded={isExpanded}
          onClick={handleToggle}
          className="group/parent-row"
        >
          {project.name}
          <span className="-mr-0.5 ml-auto flex size-6 shrink-0 items-center justify-center">
            <ChevronIcon
              className={cn(
                "text-muted-foreground transition-[opacity,rotate] duration-(--spring-fast)",
                isExpanded
                  ? "rotate-90 opacity-0 group-hover/parent-row:opacity-100 group-focus-within/parent-row:opacity-100"
                  : "opacity-100",
              )}
            />
          </span>
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
      <SidebarMenuSub open={isExpanded}>
        {sessions.map((row) => (
          <SessionRow
            key={row.session.id}
            row={row}
            nested
            isSelected={row.session.id === selection}
            actions={actions}
            onSelect={onSelect}
          />
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
}

function SessionRow(props: {
  readonly row: SessionRow;
  readonly nested: boolean;
  readonly isSelected: boolean;
  readonly actions: SidebarActions;
  readonly onSelect: (id: SessionID) => void;
}): ReactElement {
  const { row, nested, isSelected, actions, onSelect } = props;
  const { session, status, mark } = row;

  const handleSelect = useCallback(() => {
    onSelect(session.id);
  }, [onSelect, session.id]);

  const rows = useMemo(() => sessionMenuRows(session, mark, actions), [session, mark, actions]);

  const label = `${session.name} — ${statusText(status)}`;
  const current = isSelected ? "true" : undefined;

  const template = useMemo(() => <button type="button" aria-label={label} />, [label]);

  const region = (
    <ContextMenuRegion label={`Session: ${session.name}`} rows={rows} className="block">
      {nested ? (
        <SidebarMenuSubButton
          render={template}
          icon={STATUS_ICON[status]}
          aria-current={current}
          isActive={isSelected}
          onClick={handleSelect}
        >
          {session.name}
        </SidebarMenuSubButton>
      ) : (
        <SidebarMenuButton
          icon={STATUS_ICON[status]}
          aria-label={label}
          aria-current={current}
          isActive={isSelected}
          onClick={handleSelect}
        >
          {session.name}
        </SidebarMenuButton>
      )}
    </ContextMenuRegion>
  );

  return nested ? (
    <SidebarMenuSubItem>{region}</SidebarMenuSubItem>
  ) : (
    <SidebarMenuItem>{region}</SidebarMenuItem>
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
