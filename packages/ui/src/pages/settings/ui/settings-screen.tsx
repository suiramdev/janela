import {
  ArrowLeft02Icon,
  Cancel01Icon,
  ColorsIcon,
  KeyboardIcon,
  Notification01Icon,
  PlugSocketIcon,
  Search01Icon,
  SecurityCheckIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DaemonConnection } from "@janela/client";
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
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
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type BackgroundServiceControlling,
  type GlobalSettings,
  type SettingsDraft,
  type SettingsRoute,
  type SettingsTabID,
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
import {
  PROJECT_PANE_DESCRIPTION,
  SETTINGS_TAB_INFO,
  type SettingsSectionID,
  routeKey,
  sectionElementID,
  settingsMatches,
  tabInfo,
} from "../model/settings-index.ts";
import { SettingsAppearance } from "./appearance-settings.tsx";
import { SettingsIntegrations } from "./integrations-settings.tsx";
import { SettingsProfiles } from "./launch-profiles.tsx";
import { SettingsNotifications } from "./notification-settings.tsx";
import { Pane, PaneHeader } from "./pane.tsx";
import { SettingsPermissions } from "./permissions-settings.tsx";
import { ProjectSettingsPane } from "./project-settings.tsx";
import { SettingsShortcuts } from "./shortcuts-settings.tsx";

export interface SettingsTab {
  readonly id: SettingsTabID;
  readonly title: string;
  readonly icon: IconComponent;
}

export interface SettingsReveal {
  readonly section: SettingsSectionID;
  readonly at: number;
}

export type SettingsSelecting = (route: SettingsRoute, section?: SettingsSectionID) => void;

export interface SettingsSidebarProps {
  readonly route: SettingsRoute;
  readonly projects: readonly Project[];
  readonly onSelect: SettingsSelecting;
  readonly onBack: () => void;
}

interface NavRow {
  readonly route: SettingsRoute;
  readonly title: string;
  readonly icon?: IconComponent | undefined;
  readonly project?: Project | undefined;
  readonly detail?: string | undefined;
  readonly section?: SettingsSectionID | undefined;
}

export interface SettingsPaneProps {
  readonly route: SettingsRoute;
  readonly settings: GlobalSettings;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
  readonly connection: Pick<DaemonConnection, "request">;
  readonly projects: readonly Project[];
  readonly draft: SettingsDraft;
  readonly reveal?: SettingsReveal | undefined;
  readonly onRecordingShortcut: (isRecording: boolean) => void;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

const TAB_ICON = {
  appearance: hugeicon(ColorsIcon),
  notifications: hugeicon(Notification01Icon),
  shortcuts: hugeicon(KeyboardIcon),
  integrations: hugeicon(PlugSocketIcon),
  permissions: hugeicon(SecurityCheckIcon),
} satisfies Record<SettingsTabID, IconComponent>;

export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_TAB_INFO.map((info) => ({
  id: info.id,
  title: info.title,
  icon: TAB_ICON[info.id],
}));

const PANEL_ID = "janela-settings-panel";

const PANE_TITLE_ID = "janela-settings-pane-title";

const FIRST_ROUTE: SettingsRoute = { kind: "tab", tab: "appearance" };

const REVEAL_MILLISECONDS = 1400;

const rowElementID = (route: SettingsRoute): string => `janela-settings-tab-${routeKey(route)}`;

const TAB_ROWS: readonly NavRow[] = SETTINGS_TABS.map((tab) => ({
  route: { kind: "tab", tab: tab.id },
  title: tab.title,
  icon: tab.icon,
}));

const BACK_ICON = hugeicon(ArrowLeft02Icon);

export function SettingsSidebar(props: SettingsSidebarProps): ReactElement {
  const { route, projects, onSelect, onBack } = props;
  const [query, setQuery] = useState("");

  const projectRows = useMemo<readonly NavRow[]>(
    () =>
      projects.map((project) => ({
        route: { kind: "project", projectID: project.id },
        title: project.name,
        project,
      })),
    [projects],
  );

  const resultRows = useMemo<readonly NavRow[]>(
    () =>
      settingsMatches(query, projects).map((match) => {
        const { route: matched } = match;

        const project =
          matched.kind === "project"
            ? projects.find((candidate) => candidate.id === matched.projectID)
            : undefined;

        const tab = matched.kind === "tab" ? tabInfo(matched.tab) : undefined;

        return {
          route: matched,
          title: project?.name ?? tab?.title ?? "Settings",
          detail: match.detail,
          section: match.section,
          project,
          icon: tab === undefined ? undefined : TAB_ICON[tab.id],
        };
      }),
    [projects, query],
  );

  const isSearching = query.trim().length > 0;
  const firstResult = resultRows[0];

  const changeQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  }, []);

  const clearQuery = useCallback(() => {
    setQuery("");
  }, []);

  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        setQuery("");

        return;
      }

      if (event.key !== "Enter" || firstResult === undefined) return;

      onSelect(firstResult.route, firstResult.section);
    },
    [firstResult, onSelect],
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
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={changeQuery}
            onKeyDown={keyDown}
            placeholder="Search settings"
            aria-label="Search settings"
            autoComplete="off"
            spellCheck={false}
          />
          {isSearching ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={clearQuery}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </InputGroupButton>
            </InputGroupAddon>
          ) : undefined}
        </InputGroup>
      </SidebarChromeHeader>

      <SidebarContent className={SIDEBAR_SCROLLER}>
        <SidebarMenu role="tablist" aria-orientation="vertical" aria-label="Settings">
          {isSearching ? (
            <SidebarGroup className="py-1">
              <SidebarGroupLabel role="presentation">Results</SidebarGroupLabel>
              {resultRows.length === 0 ? (
                <Empty className="p-3" role="presentation">
                  <EmptyDescription className="text-muted-foreground text-xs">
                    Nothing matches “{query.trim()}”.
                  </EmptyDescription>
                </Empty>
              ) : undefined}
              {resultRows.map((row) => (
                <SettingsRow
                  key={routeKey(row.route)}
                  row={row}
                  isSelected={sameRoute(row.route, route)}
                  onSelect={onSelect}
                />
              ))}
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup className="py-1">
                <SidebarGroupLabel role="presentation">Janela</SidebarGroupLabel>
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
            </>
          )}
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
  readonly onSelect: SettingsSelecting;
}): ReactElement {
  const { row, isSelected, onSelect } = props;
  const { route, title, icon, project, detail, section } = row;

  const show = useCallback(() => {
    onSelect(route, section);
  }, [onSelect, route, section]);

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
        <span className="truncate">{title}</span>
        {detail === undefined ? undefined : (
          <span className="text-muted-foreground ml-auto max-w-[9rem] shrink-0 truncate text-[0.6875rem]">
            {detail}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SettingsPane(props: SettingsPaneProps): ReactElement {
  const { reveal, route, projects } = props;

  const project =
    route.kind === "project"
      ? projects.find((candidate) => candidate.id === route.projectID)
      : undefined;

  const info = route.kind === "tab" ? tabInfo(route.tab) : undefined;

  useEffect(() => {
    if (reveal === undefined) return undefined;

    const element = document.getElementById(sectionElementID(reveal.section));

    if (element === null) return undefined;

    element.scrollIntoView({ block: "start" });
    element.setAttribute("data-revealed", "true");

    const timer = setTimeout(() => {
      element.removeAttribute("data-revealed");
    }, REVEAL_MILLISECONDS);

    return () => {
      clearTimeout(timer);
      element.removeAttribute("data-revealed");
    };
  }, [reveal]);

  return (
    <section
      id={PANEL_ID}
      role="tabpanel"
      aria-labelledby={PANE_TITLE_ID}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {route.kind === "project" && project === undefined ? undefined : (
        <Pane>
          <PaneHeader
            id={PANE_TITLE_ID}
            title={project?.name ?? info?.title ?? "Settings"}
            description={
              project === undefined ? (info?.description ?? "") : PROJECT_PANE_DESCRIPTION
            }
            directory={project?.directory}
          />
          <PaneBody {...props} project={project} />
        </Pane>
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
        onChange={changeProject}
      />
    );
  }

  return Match.value(props.route.tab).pipe(
    Match.when("appearance", () => (
      <SettingsAppearance settings={settings} onChange={changeSettings} />
    )),
    Match.when("notifications", () => (
      <SettingsNotifications settings={settings} onChange={changeSettings} />
    )),
    Match.when("shortcuts", () => (
      <SettingsShortcuts
        settings={settings}
        onChange={changeSettings}
        onRecording={props.onRecordingShortcut}
      />
    )),
    Match.when("integrations", () => (
      <>
        <SettingsProfiles
          profiles={props.profiles}
          availability={props.availability}
          draft={draft}
          onChangeDraft={onChangeDraft}
        />
        <SettingsIntegrations connection={props.connection} />
      </>
    )),
    Match.when("permissions", () => (
      <SettingsPermissions
        settings={settings}
        onChange={changeSettings}
        sessions={props.sessions}
        terminalStates={props.terminalStates}
        service={props.service}
      />
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
  if (route.kind === "tab") return tabInfo(route.tab)?.title ?? "Settings";

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
  const [reveal, setReveal] = useState<SettingsReveal | undefined>(undefined);

  const select = useCallback<SettingsSelecting>(
    (next, section) => {
      view.showSettings(next);
      setReveal(section === undefined ? undefined : { section, at: Date.now() });
    },
    [view],
  );

  const back = useCallback(() => {
    view.showWorkspace();
  }, [view]);

  const recordShortcut = useCallback(
    (isRecording: boolean) => {
      view.setRecordingShortcut(isRecording);
    },
    [view],
  );

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
      ? FIRST_ROUTE
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
            service={environment.local?.service}
            connection={connection}
            projects={projects}
            draft={draft}
            reveal={reveal}
            onChangeDraft={changeDraft}
            onRecordingShortcut={recordShortcut}
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
