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
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSize,
  type IconComponent,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import type { BackgroundServiceControlling } from "./background-service.ts";
import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import type { GlobalSettings } from "./global-settings.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { ProjectSettingsPane } from "./project-settings.tsx";
import type { SettingsDraft } from "./settings-draft.ts";
import {
  draftEditCount,
  draftProfiles,
  draftProjectSettings,
  draftSettings,
  draftSettingsToSave,
  draftViolations,
  settingsDraftRequests,
  withDraftProjectSettings,
  withDraftSettings,
} from "./settings-draft.ts";
import { SettingsGeneral } from "./settings-general.tsx";
import { SettingsNotifications } from "./settings-notifications.tsx";
import { SettingsProfiles } from "./settings-profiles.tsx";
import { SettingsTerminal } from "./settings-terminal.tsx";
import { sameRoute, type SettingsRoute, type SettingsTabID } from "./view-state.ts";
import {
  ContentCard,
  PANE_COLUMN,
  SIDEBAR_SCROLLER,
  ShowSidebarBar,
  WINDOW_COLUMN,
  WindowControlsRoom,
} from "./window-chrome.tsx";

/**
 * The settings screen: the sidebar becomes the navigation, the content area the
 * pane.
 *
 * ```text
 * ┌──────────────────────────────┐
 * │ Settings                [▤]  │
 * │  🔧 General                  │  ← four tabs: the application itself
 * │  ▭ Terminal                  │
 * │  ✦ Profiles                  │
 * │  🔔 Notifications            │
 * │ Projects                     │  ← one row per project, from the mirror
 * │  ▣ janela                    │
 * │  ▣ api                       │
 * ├──────────────────────────────┤
 * │ ← Back                       │
 * └──────────────────────────────┘
 * ```
 *
 * ## Why a screen and not a sheet
 *
 * Settings used to open in a dialog over the terminals. The terminals are the
 * application, and a dialog over them meant reading settings through a scrim in
 * a box that could not hold a tab strip and a form at once. So `ViewState.screen`
 * swaps the whole window: `SettingsSidebar` where `AppSidebar` was, the chosen
 * pane where the panes were, and one Back button pinned where the Settings button
 * was. The window's shape does not change; what fills it does.
 *
 * ## Why the projects are here
 *
 * A project's settings — its worktree root, its automation commands, its default
 * profile — used to open as a sheet from the project's row in the sidebar, on the
 * argument that the place you edit a project is the project. That was wrong in
 * two ways that only showed up once the form had grown:
 *
 * - **It is the largest form in the application**, and it was the one surface
 *   read through a scrim, in a modal that could not be left open while the user
 *   looked at the repository it configures.
 * - **It was the only settings you could not find by looking.** Every other
 *   preference in the product is behind one button; these were behind knowing to
 *   right-click a row. "Settings is where settings are" is worth more than the
 *   theory that a per-project form has to live next to the project.
 *
 * So a project is a **route** in this screen rather than a fifth tab: the tabs
 * are fixed data, the projects are the mirror's list, and both are rows in the
 * same navigation — which is also what makes the sidebar's *Project Settings*
 * row a link to somewhere rather than a second editor.
 *
 * ## Why the tabs are data
 *
 * Same reason `COMMANDS` is: the navigation and anything that opens a specific
 * tab (a menu item, a deep link from a banner) read one table, so they cannot
 * drift.
 */

export interface SettingsTab {
  readonly id: SettingsTabID;
  readonly title: string;
  /** The row's glyph, as the component `SidebarMenuButton` renders in its icon
   *  column. Built once here, because a component type made per render remounts
   *  the icon on every keystroke elsewhere in the window. */
  readonly icon: IconComponent;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", title: "General", icon: hugeicon(WrenchIcon) },
  { id: "terminal", title: "Terminal", icon: hugeicon(TerminalIcon) },
  { id: "profiles", title: "Profiles", icon: hugeicon(SparklesIcon) },
  { id: "notifications", title: "Notifications", icon: hugeicon(Notification01Icon) },
];

const PANEL_ID = "janela-settings-panel";
/** Where the screen opens, and where it falls back to. */
const GENERAL_ROUTE: SettingsRoute = { kind: "tab", tab: "general" };
/**
 * Stable per route: it is the row's `id`, and it is what `aria-labelledby` on
 * the pane points at.
 */
const routeKey = (route: SettingsRoute): string =>
  route.kind === "tab" ? route.tab : `project-${route.projectID}`;
const rowElementID = (route: SettingsRoute): string => `janela-settings-tab-${routeKey(route)}`;

// MARK: - Sidebar

export interface SettingsSidebarProps {
  readonly route: SettingsRoute;
  readonly projects: readonly Project[];
  readonly onSelect: (route: SettingsRoute) => void;
  readonly onBack: () => void;
}

/**
 * One row of the navigation, as data.
 *
 * Built once per table (the tabs) or once per mirror update (the projects),
 * rather than per render: a `route` object made inside the JSX would be a new
 * prop identity on every keystroke elsewhere in the window, which is what the
 * `react-perf` rule in the lint gate is for.
 */
interface NavRow {
  readonly route: SettingsRoute;
  readonly title: string;
  /** A tab's glyph. Absent for a project, which brings its own picture. */
  readonly icon?: IconComponent;
  readonly project?: Project;
}

const TAB_ROWS: readonly NavRow[] = SETTINGS_TABS.map((tab) => ({
  route: { kind: "tab", tab: tab.id },
  title: tab.title,
  icon: tab.icon,
}));

/**
 * The navigation, as the sidebar, with Back pinned at the bottom.
 *
 * A real `tablist`: the buttons carry `role="tab"` and `aria-selected`, so a
 * screen reader hears "tab, 5 of 6" rather than a list of unrelated buttons.
 *
 * ## Who moves the keyboard
 *
 * The sidebar primitive does. It already rovers focus across every row of a
 * menu scope in DOM order — ↑/↓, wrapping, plus Home and End — and it stops the
 * event, so a second handler here would fight it: a hand-rolled one shipped in
 * the first draft and the two disagreed the moment focus and selection were on
 * different rows, moving the pane two places while focus moved one.
 *
 * So selection follows **focus**, the automatic-activation pattern: whatever
 * ends up focused is what shows. A pane is cheap to show and there is nothing
 * to lose by showing it, which is what makes the pattern legitimate here.
 *
 * One consequence worth naming: the projects are a second group under a
 * heading, inside the same `tablist`, so ↑/↓ crosses the heading — a heading is
 * a label, not a stop, and Down at *Notifications* means the next row.
 */
export function SettingsSidebar(props: SettingsSidebarProps): ReactElement {
  const { route, projects, onSelect, onBack } = props;
  const size = useSize();

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
    // The same window, with different contents: `variant="inset"` for the same
    // reason `AppSidebar` has it, and the same collapse control in the same
    // place. Settings used to be the one screen where the sidebar sat against
    // the window frame and could not be collapsed at all — a second layout for
    // no reason anyone could name.
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader>
        {/* The window controls land on this row here too — it is the same window
            and the same first row, holding a different word. */}
        <div className={cn(size.control, "flex items-center gap-0.5")}>
          <WindowControlsRoom />
          <h1
            className="text-muted-foreground flex-1 truncate px-1 text-xs font-medium"
            data-tauri-drag-region
          >
            Settings
          </h1>
          {/* The primitive's trigger carries its own tooltip, with the ⌘B chip
              in it — the same control the main window's header has. */}
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent className={SIDEBAR_SCROLLER}>
        {/* One `tablist` across both groups, so the rows are numbered together
            and the arrow keys are one sequence. The heading between them is a
            `presentation` label inside the list rather than a row in it. */}
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
              // A heading over nothing reads as a list that failed to load. The
              // same `Empty` the workspace sidebar uses, so the two lists say
              // "there is nothing here" the same way — and it does not repeat
              // that sidebar's Add Project button, which is not on this screen.
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

const BACK_ICON = hugeicon(ArrowLeft02Icon);

/**
 * One row of the navigation, for a tab or for a project.
 *
 * A project brings its generated icon instead of a glyph — the same picture its
 * row in the workspace sidebar has, which is what makes this list recognisable
 * as *those* projects rather than a second set of names.
 */
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
        // Selection follows focus, which is what makes the primitive's own
        // ↑/↓/Home/End move the pane without this file handling a key. A click
        // focuses too, so `onClick` is the redundant one — kept because a click
        // on the already-focused row must still show it.
        onFocus={show}
      >
        {project === undefined ? undefined : <ProjectIcon project={project} />}
        {title}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// MARK: - Pane

export interface SettingsPaneProps {
  readonly route: SettingsRoute;
  /** The stored global settings. The draft is read against them, not over them. */
  readonly settings: GlobalSettings;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  /** The mirror's sessions, for the background service's stated cost. */
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling;
  /** The mirror's projects: the Projects section's rows, and their settings. */
  readonly projects: readonly Project[];
  readonly draft: SettingsDraft;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

/** The chosen route's content, filling the area the terminals normally do. */
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

  // The scroller, and nothing else: the Save bar is a sibling of this panel
  // rather than part of it, because it commits every tab's edits and not just
  // the one on screen.
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
    // A project the mirror no longer has renders nothing rather than an editor
    // over nothing: the daemon is the source of truth, and it has said this
    // project is gone. `SettingsScreen` sends the navigation back to General.
    if (project === undefined) return null;
    return (
      <ProjectSettingsPane
        // Keyed by project, so switching rows opens the next form from the top
        // rather than reusing the previous one's field state.
        key={project.id}
        project={project}
        settings={draftProjectSettings(draft, project)}
        profiles={draftProfiles(draft, props.profiles)}
        availability={props.availability}
        onChange={changeProject}
      />
    );
  }

  switch (props.route.tab) {
    case "general":
      return (
        <SettingsGeneral
          settings={settings}
          onChange={changeSettings}
          // The draft's profiles, so a profile renamed on the Profiles tab reads
          // the same here before either has been saved.
          profiles={draftProfiles(draft, props.profiles)}
          availability={props.availability}
          sessions={props.sessions}
          terminalStates={props.terminalStates}
          service={props.service}
        />
      );
    case "terminal":
      return <SettingsTerminal settings={settings} onChange={changeSettings} />;
    case "profiles":
      return (
        <SettingsProfiles
          profiles={props.profiles}
          availability={props.availability}
          draft={draft}
          onChangeDraft={onChangeDraft}
        />
      );
    case "notifications":
      return <SettingsNotifications settings={settings} onChange={changeSettings} />;
  }
}

// MARK: - The bar

/**
 * Where every tab's edits are committed or thrown away.
 *
 * One bar for the whole screen, in one place, always visible. The alternative —
 * a bar that appears when something is dirty — moves the content the moment the
 * user types, and hides the fact that this screen has a commit model at all until
 * after they have changed something.
 *
 * At rest it is quiet: both buttons disabled and no message, which says "nothing
 * to save" without a sentence. Dirty, it says how many changes it would write,
 * because with one Save for every tab that number is the only thing telling the
 * user their reach extends past the pane they are looking at.
 */
function SettingsCommitBar(props: {
  readonly isDirty: boolean;
  readonly editCount: number;
  /** The first thing stopping a save, and where to go to fix it. */
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
            // A button, not a line of text: the thing blocking the save is
            // frequently on another pane, and reading its name without being
            // able to get there is worse than not being told.
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

// MARK: - Screen

/** A request from a view is best-effort. Failing one is not an application error. */
function swallowRequestFailure(): undefined {
  return undefined;
}

/** What a violation's route is called, so the bar can name where to go. */
function routeLabel(route: SettingsRoute, projects: readonly Project[]): string {
  if (route.kind === "tab") {
    return SETTINGS_TABS.find((tab) => tab.id === route.tab)?.title ?? "Settings";
  }
  return projects.find((project) => project.id === route.projectID)?.name ?? "Project";
}

/**
 * The connected screen: the sidebar, the pane and the bar, wired to the mirror
 * and to `ViewState`. `MainWindow` renders this in place of the workspace.
 */
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

  // Bumped by Revert, and used as the pane's key. The panes hold field state the
  // draft cannot: argv rows carry identities, and the open profile editor a
  // working copy. Discarding the draft has to discard those too, or a reverted
  // command would keep showing the text the user typed into it.
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
    // Read from the store rather than from the render that built this callback:
    // the draft may have moved on since, and a save writes what is there now.
    // Both halves, because what a save writes is the difference between them.
    const pending = view.settingsDraft;
    const saved = view.savedSettingsDraft;

    const nextSettings = draftSettingsToSave(pending, saved);
    if (nextSettings !== undefined) {
      view.setSettings(nextSettings);
      environment.settings.save(nextSettings).catch(swallowRequestFailure);
    }
    // Global settings are the client's own store; everything else is the
    // daemon's, and `settingsDraftRequests` is what turns the draft into writes.
    for (const message of settingsDraftRequests(pending, saved)) {
      connection.request(message).catch(swallowRequestFailure);
    }

    view.settingsDraftSaved();
  }, [connection, environment, view]);

  const revert = useCallback(() => {
    view.revertSettingsDraft();
    setRevision((current) => current + 1);
  }, [view]);

  // A project the mirror no longer has shows General instead. Derived rather
  // than written back: a store write during render would notify subscribers
  // mid-render, and the stale route is harmless — re-entering settings derives
  // this same answer again.
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
      {/* The column, the bar and the card the workspace uses, in that order:
          the shape of the window belongs to the window, not to what fills it. */}
      <SidebarInset className={WINDOW_COLUMN}>
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
      </SidebarInset>
    </>
  );
}
