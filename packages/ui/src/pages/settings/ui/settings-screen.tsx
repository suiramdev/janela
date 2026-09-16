import {
  ArrowLeft02Icon,
  Notification01Icon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import type {
  LaunchProfile,
  LaunchProfileAvailability,
  Project,
  ProjectSettings,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  Button,
  cn,
  Empty,
  EmptyDescription,
  hugeicon,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  type IconComponent,
} from "@janela/design";
import { Match } from "effect";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import {
  type BackgroundServiceControlling,
  type GlobalSettings,
  type SettingsDraft,
  type SettingsRoute,
  type SettingsTabID,
  draftProfiles,
  draftProjectSettings,
  draftSettings,
  sameRoute,
  useClientEnvironment,
  useStoreValue,
  withDraftProjectSettings,
  withDraftSettings,
} from "../../../shared/model/index.ts";
import {
  ContentCard,
  PANE_COLUMN,
  ProjectIcon,
  SIDEBAR_SCROLLER,
  ShowSidebarBar,
  SidebarChromeHeader,
  SidebarTitleRow,
  WindowColumn,
} from "../../../shared/ui/index.ts";
import {
  draftEditCount,
  draftSettingsToSave,
  draftViolations,
  settingsDraftRequests,
} from "../model/draft-save.ts";
import { SettingsGeneral } from "./general-settings.tsx";
import { SettingsProfiles } from "./launch-profiles.tsx";
import { SettingsNotifications } from "./notification-settings.tsx";
import { ProjectSettingsPane } from "./project-settings.tsx";
import { SettingsTerminal } from "./terminal-settings.tsx";

export interface SettingsTab {
  readonly id: SettingsTabID;
  readonly title: string;
  readonly icon: IconComponent;
}

export interface SettingsSidebarProps {
  readonly route: SettingsRoute;
  readonly projects: readonly Project[];
  readonly onSelect: (route: SettingsRoute) => void;
  readonly onBack: () => void;
}

interface NavRow {
  readonly route: SettingsRoute;
  readonly title: string;
  readonly icon?: IconComponent;
  readonly project?: Project;
}

export interface SettingsPaneProps {
  readonly route: SettingsRoute;
  readonly settings: GlobalSettings;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling;
  readonly projects: readonly Project[];
  readonly draft: SettingsDraft;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", title: "General", icon: hugeicon(WrenchIcon) },
  { id: "terminal", title: "Terminal", icon: hugeicon(TerminalIcon) },
  { id: "profiles", title: "Profiles", icon: hugeicon(SparklesIcon) },
  { id: "notifications", title: "Notifications", icon: hugeicon(Notification01Icon) },
];

const PANEL_ID = "janela-settings-panel";

const GENERAL_ROUTE: SettingsRoute = { kind: "tab", tab: "general" };

const routeKey = (route: SettingsRoute): string =>
  route.kind === "tab" ? route.tab : `project-${route.projectID}`;

const rowElementID = (route: SettingsRoute): string => `janela-settings-tab-${routeKey(route)}`;

const TAB_ROWS: readonly NavRow[] = SETTINGS_TABS.map((tab) => ({
  route: { kind: "tab", tab: tab.id },
  title: tab.title,
  icon: tab.icon,
}));

const BACK_ICON = hugeicon(ArrowLeft02Icon);

export function SettingsSidebar(props: SettingsSidebarProps): ReactElement {
  const { route, projects, onSelect, onBack } = props;

  const projectRows = useMemo<readonly NavRow[]>(
    () =>
      projects.map((project) => ({
        route: { kind: "project", projectID: project.id },
        title: project.name,
        project,
      })),
    [projects],
  );

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarChromeHeader>
        <SidebarTitleRow>
          <h1 className="text-muted-foreground flex-1 truncate px-1 text-xs font-medium">
            Settings
          </h1>
          <SidebarTrigger />
        </SidebarTitleRow>
      </SidebarChromeHeader>

      <SidebarContent className={SIDEBAR_SCROLLER}>
        <SidebarMenu role="tablist" aria-orientation="vertical" aria-label="Settings">
          <SidebarGroup className="py-1">
            {TAB_ROWS.map((row) => (
              <SettingsRow
                key={row.title}
                row={row}
                isSelected={sameRoute(row.route, route)}
                onSelect={onSelect}
              />
            ))}
          </SidebarGroup>

          <SidebarGroup className="py-1">
            <SidebarGroupLabel role="presentation">Projects</SidebarGroupLabel>
            {projects.length === 0 ? (
              <Empty className="p-3" role="presentation">
                <EmptyDescription className="text-muted-foreground text-xs">
                  No projects yet.
                </EmptyDescription>
              </Empty>
            ) : undefined}
            {projectRows.map((row) => (
              <SettingsRow
                key={row.project?.id}
                row={row}
                isSelected={sameRoute(row.route, route)}
                onSelect={onSelect}
              />
            ))}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="border-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton icon={BACK_ICON} onClick={onBack}>
              Back
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function SettingsRow(props: {
  readonly row: NavRow;
  readonly isSelected: boolean;
  readonly onSelect: (route: SettingsRoute) => void;
}): ReactElement {
  const { row, isSelected, onSelect } = props;
  const { route, title, icon, project } = row;

  const show = useCallback(() => {
    onSelect(route);
  }, [onSelect, route]);

  return (
    <SidebarMenuItem role="presentation">
      <SidebarMenuButton
        id={rowElementID(route)}
        role="tab"
        {...(icon === undefined ? {} : { icon })}
        aria-selected={isSelected}
        aria-controls={PANEL_ID}
        isActive={isSelected}
        onClick={show}
        onFocus={show}
      >
        {project === undefined ? undefined : <ProjectIcon project={project} />}
        {title}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SettingsPane(props: SettingsPaneProps): ReactElement {
  const { route, projects } = props;

  const project =
    route.kind === "project"
      ? projects.find((candidate) => candidate.id === route.projectID)
      : undefined;

  const tab =
    route.kind === "tab"
      ? SETTINGS_TABS.find((candidate) => candidate.id === route.tab)
      : undefined;

  return (
    <section
      id={PANEL_ID}
      role="tabpanel"
      aria-labelledby={rowElementID(route)}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {route.kind === "project" ? (
        <PaneBody {...props} project={project} />
      ) : (
        <div className={PANE_COLUMN}>
          <h2 className="text-base font-semibold">{tab?.title}</h2>
          <div className="mt-5">
            <PaneBody {...props} project={undefined} />
          </div>
        </div>
      )}
    </section>
  );
}

function PaneBody(
  props: SettingsPaneProps & { readonly project: Project | undefined },
): ReactElement | null {
  const { draft, onChangeDraft, project } = props;
  const settings = draftSettings(draft, props.settings);
  const projectID = project?.id;

  const changeSettings = useCallback(
    (next: GlobalSettings) => {
      onChangeDraft(withDraftSettings(draft, next));
    },
    [draft, onChangeDraft],
  );

  const changeProject = useCallback(
    (next: ProjectSettings) => {
      if (projectID === undefined) return;

      onChangeDraft(withDraftProjectSettings(draft, projectID, next));
    },
    [draft, onChangeDraft, projectID],
  );

  if (props.route.kind === "project") {
    if (project === undefined) return null;

    return (
      <ProjectSettingsPane
        key={project.id}
        project={project}
        settings={draftProjectSettings(draft, project)}
        profiles={draftProfiles(draft, props.profiles)}
        availability={props.availability}
        onChange={changeProject}
      />
    );
  }

  return Match.value(props.route.tab).pipe(
    Match.when("general", () => (
      <SettingsGeneral
        settings={settings}
        onChange={changeSettings}
        profiles={draftProfiles(draft, props.profiles)}
        availability={props.availability}
        sessions={props.sessions}
        terminalStates={props.terminalStates}
        service={props.service}
      />
    )),
    Match.when("terminal", () => (
      <SettingsTerminal settings={settings} onChange={changeSettings} />
    )),
    Match.when("profiles", () => (
      <SettingsProfiles
        profiles={props.profiles}
        availability={props.availability}
        draft={draft}
        onChangeDraft={onChangeDraft}
      />
    )),
    Match.when("notifications", () => (
      <SettingsNotifications settings={settings} onChange={changeSettings} />
    )),
    Match.exhaustive,
  );
}

function SettingsCommitBar(props: {
  readonly isDirty: boolean;
  readonly editCount: number;
  readonly blocker: { readonly label: string; readonly message: string } | undefined;
  readonly onShowBlocker: () => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
}): ReactElement {
  const { isDirty, editCount, blocker } = props;

  return (
    <footer className="border-border shrink-0 border-t">
      <div className={cn(PANE_COLUMN, "flex items-center gap-3 py-3")}>
        <div className="min-w-0 flex-1 text-xs" aria-live="polite">
          {blocker === undefined ? (
            isDirty ? (
              <span className="text-muted-foreground">
                {editCount === 1 ? "1 unsaved change" : `${editCount} unsaved changes`}
              </span>
            ) : undefined
          ) : (
            <button
              type="button"
              onClick={props.onShowBlocker}
              className="text-destructive truncate text-left underline-offset-2 hover:underline"
            >
              {blocker.label} — {blocker.message}
            </button>
          )}
        </div>
        <Button variant="outline" onClick={props.onRevert} disabled={!isDirty}>
          Revert
        </Button>
        <Button onClick={props.onSave} disabled={!isDirty || blocker !== undefined}>
          Save
        </Button>
      </div>
    </footer>
  );
}

function swallowRequestFailure(): undefined {
  return undefined;
}

function routeLabel(route: SettingsRoute, projects: readonly Project[]): string {
  if (route.kind === "tab") {
    return SETTINGS_TABS.find((tab) => tab.id === route.tab)?.title ?? "Settings";
  }

  return projects.find((project) => project.id === route.projectID)?.name ?? "Project";
}

export function SettingsScreen(props: { readonly route: SettingsRoute }): ReactElement {
  const environment = useClientEnvironment();
  const { view, projects: projectStore, sessions: sessionStore, connection } = environment;

  const projects = useStoreValue(projectStore, () => projectStore.projects);
  const sessions = useStoreValue(sessionStore, () => sessionStore.sessions);
  const terminalStates = useStoreValue(sessionStore, () => sessionStore.terminalStates);
  const profiles = useStoreValue(sessionStore, () => sessionStore.launchProfiles);
  const availability = useStoreValue(sessionStore, () => sessionStore.launchProfileAvailability);
  const settings = useStoreValue(view, () => view.settings);
  const draft = useStoreValue(view, () => view.settingsDraft);
  const savedDraft = useStoreValue(view, () => view.savedSettingsDraft);
  const isDirty = useStoreValue(view, () => view.hasUnsavedSettings);

  const [revision, setRevision] = useState(0);

  const select = useCallback(
    (route: SettingsRoute) => {
      view.showSettings(route);
    },
    [view],
  );

  const back = useCallback(() => {
    view.showWorkspace();
  }, [view]);

  const changeDraft = useCallback(
    (next: SettingsDraft) => {
      view.editSettingsDraft(next);
    },
    [view],
  );

  const save = useCallback(() => {
    const pending = view.settingsDraft;
    const saved = view.savedSettingsDraft;

    const nextSettings = draftSettingsToSave(pending, saved);

    if (nextSettings !== undefined) {
      view.setSettings(nextSettings);
      environment.settings.save(nextSettings).catch(swallowRequestFailure);
    }

    for (const message of settingsDraftRequests(pending, saved)) {
      connection.request(message).catch(swallowRequestFailure);
    }

    view.settingsDraftSaved();
  }, [connection, environment, view]);

  const revert = useCallback(() => {
    view.revertSettingsDraft();
    setRevision((current) => current + 1);
  }, [view]);

  const requested = props.route;

  const route: SettingsRoute =
    requested.kind === "project" &&
    !projects.some((candidate) => candidate.id === requested.projectID)
      ? GENERAL_ROUTE
      : requested;

  const violation = draftViolations(draft)[0];

  const blocker = useMemo(
    () =>
      violation === undefined
        ? undefined
        : { label: routeLabel(violation.route, projects), message: violation.message },
    [projects, violation],
  );

  const showBlocker = useCallback(() => {
    if (violation !== undefined) view.showSettings(violation.route);
  }, [view, violation]);

  return (
    <>
      <SettingsSidebar route={route} projects={projects} onSelect={select} onBack={back} />
      <WindowColumn>
        <ShowSidebarBar />
        <ContentCard className="flex flex-col">
          <SettingsPane
            key={revision}
            route={route}
            settings={settings}
            profiles={profiles}
            availability={availability}
            sessions={sessions}
            terminalStates={terminalStates}
            service={environment.service}
            projects={projects}
            draft={draft}
            onChangeDraft={changeDraft}
          />
          <SettingsCommitBar
            isDirty={isDirty}
            editCount={draftEditCount(draft, savedDraft)}
            blocker={blocker}
            onShowBlocker={showBlocker}
            onSave={save}
            onRevert={revert}
          />
        </ContentCard>
      </WindowColumn>
    </>
  );
}
