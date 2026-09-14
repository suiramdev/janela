import {
  ArrowLeft02Icon,
  Notification01Icon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type {
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@janela/design";
import type { KeyboardEvent, ReactElement } from "react";
import { useCallback, useMemo } from "react";

import type { BackgroundServiceControlling } from "./background-service.ts";
import { useClientEnvironment, useStoreValue } from "./client-environment.tsx";
import type { GlobalSettings } from "./global-settings.ts";
import { SettingsGeneral } from "./settings-general.tsx";
import { SettingsNotifications } from "./settings-notifications.tsx";
import { SettingsProfiles, type ProfileEditing } from "./settings-profiles.tsx";
import { SettingsTerminal } from "./settings-terminal.tsx";

/**
 * The settings screen: the sidebar becomes four tabs, the content area the pane.
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
 * ## Why there is no Projects tab
 *
 * A project's settings — its worktree root, its automation commands, its default
 * profile — belong to that project and are edited from its row in the sidebar,
 * through `ProjectSettingsSheet`. A Projects tab would be a second place to find
 * them and a list to navigate to get there, which is a worse version of clicking
 * the project you were already looking at. It would also imply projects are
 * configured globally, which is exactly backwards: they are the *only* per-scope
 * settings that exist.
 *
 * ## Why the tabs are data
 *
 * Same reason `COMMANDS` is: the navigation and anything that opens a specific
 * tab (a menu item, a deep link from a banner) read one table, so they cannot
 * drift.
 */

export type SettingsTabID = "general" | "terminal" | "profiles" | "notifications";

export interface SettingsTab {
  readonly id: SettingsTabID;
  readonly title: string;
  readonly icon: IconSvgElement;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", title: "General", icon: WrenchIcon },
  { id: "terminal", title: "Terminal", icon: TerminalIcon },
  { id: "profiles", title: "Profiles", icon: SparklesIcon },
  { id: "notifications", title: "Notifications", icon: Notification01Icon },
];

/** The tab after `tab` in `delta` direction, wrapping — what ↑ and ↓ move to. */
export function neighbouringTab(tab: SettingsTabID, delta: -1 | 1): SettingsTabID {
  const at = SETTINGS_TABS.findIndex((entry) => entry.id === tab);
  const count = SETTINGS_TABS.length;
  const next = SETTINGS_TABS[((at === -1 ? 0 : at) + delta + count) % count];
  return next === undefined ? tab : next.id;
}

const PANEL_ID = "janela-settings-panel";
const tabElementID = (tab: SettingsTabID): string => `janela-settings-tab-${tab}`;

// MARK: - Sidebar

export interface SettingsSidebarProps {
  readonly tab: SettingsTabID;
  readonly onSelectTab: (tab: SettingsTabID) => void;
  readonly onBack: () => void;
}

/**
 * The tabs, as the sidebar, with Back pinned at the bottom.
 *
 * A real `tablist`: the buttons carry `role="tab"` and `aria-selected`, and ↑/↓
 * move between them, so a screen reader hears "tab, 2 of 4" rather than a list of
 * unrelated buttons. Selection follows focus, the automatic-activation pattern —
 * a pane is cheap to show and there is nothing to lose by showing it.
 */
export function SettingsSidebar(props: SettingsSidebarProps): ReactElement {
  const { tab, onSelectTab, onBack } = props;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : undefined;
      if (delta === undefined) return;
      event.preventDefault();
      const next = neighbouringTab(tab, delta);
      onSelectTab(next);
      document.getElementById(tabElementID(next))?.focus();
    },
    [tab, onSelectTab],
  );

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-sidebar-border border-b px-3 py-2.5">
        <h1 className="text-sidebar-foreground text-xs font-medium">Settings</h1>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="py-1">
          <SidebarMenu role="tablist" aria-orientation="vertical" aria-label="Settings">
            {SETTINGS_TABS.map((entry) => (
              <SettingsTabRow
                key={entry.id}
                entry={entry}
                isSelected={entry.id === tab}
                onSelect={onSelectTab}
                onKeyDown={handleKeyDown}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" onClick={onBack}>
              <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

function SettingsTabRow(props: {
  readonly entry: SettingsTab;
  readonly isSelected: boolean;
  readonly onSelect: (tab: SettingsTabID) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}): ReactElement {
  const { entry, isSelected, onSelect, onKeyDown } = props;
  const handleClick = useCallback(() => {
    onSelect(entry.id);
  }, [onSelect, entry.id]);

  return (
    <SidebarMenuItem role="presentation">
      <SidebarMenuButton
        id={tabElementID(entry.id)}
        role="tab"
        size="sm"
        aria-selected={isSelected}
        aria-controls={PANEL_ID}
        isActive={isSelected}
        onClick={handleClick}
        onKeyDown={onKeyDown}
      >
        <HugeiconsIcon icon={entry.icon} strokeWidth={2} />
        <span>{entry.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// MARK: - Pane

export interface SettingsPaneProps {
  readonly tab: SettingsTabID;
  readonly settings: GlobalSettings;
  readonly onChangeSettings: (settings: GlobalSettings) => void;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly profileEditing: ProfileEditing;
  /** The mirror's sessions, for the background service's stated cost. */
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling;
}

/** The chosen tab's content, filling the area the terminals normally do. */
export function SettingsPane(props: SettingsPaneProps): ReactElement {
  const entry = SETTINGS_TABS.find((candidate) => candidate.id === props.tab);
  return (
    <section
      id={PANEL_ID}
      role="tabpanel"
      aria-labelledby={tabElementID(props.tab)}
      className="h-full min-h-0 overflow-y-auto"
    >
      <div className="mx-auto max-w-2xl p-6">
        <h2 className="mb-5 text-base font-semibold">{entry?.title}</h2>
        <PaneBody {...props} />
      </div>
    </section>
  );
}

function PaneBody(props: SettingsPaneProps): ReactElement {
  switch (props.tab) {
    case "general":
      return (
        <SettingsGeneral
          settings={props.settings}
          onChange={props.onChangeSettings}
          profiles={props.profiles}
          availability={props.availability}
          sessions={props.sessions}
          terminalStates={props.terminalStates}
          service={props.service}
        />
      );
    case "terminal":
      return <SettingsTerminal settings={props.settings} onChange={props.onChangeSettings} />;
    case "profiles":
      return (
        <SettingsProfiles
          profiles={props.profiles}
          availability={props.availability}
          editing={props.profileEditing}
        />
      );
    case "notifications":
      return <SettingsNotifications settings={props.settings} onChange={props.onChangeSettings} />;
  }
}

// MARK: - Screen

/** A request from a view is best-effort. Failing one is not an application error. */
function swallowRequestFailure(): undefined {
  return undefined;
}

/**
 * The connected screen: the sidebar and the pane, wired to the mirror and to
 * `ViewState`. `MainWindow` renders this in place of the workspace.
 */
export function SettingsScreen(props: { readonly tab: SettingsTabID }): ReactElement {
  const environment = useClientEnvironment();
  const { view, sessions: sessionStore, connection } = environment;

  const sessions = useStoreValue(sessionStore, () => sessionStore.sessions);
  const terminalStates = useStoreValue(sessionStore, () => sessionStore.terminalStates);
  const profiles = useStoreValue(sessionStore, () => sessionStore.launchProfiles);
  const availability = useStoreValue(sessionStore, () => sessionStore.launchProfileAvailability);
  const settings = useStoreValue(view, () => view.settings);

  const selectTab = useCallback(
    (tab: SettingsTabID) => {
      view.showSettings(tab);
    },
    [view],
  );
  const back = useCallback(() => {
    view.showWorkspace();
  }, [view]);

  const changeSettings = useCallback(
    (next: GlobalSettings) => {
      view.setSettings(next);
      environment.settings.save(next).catch(swallowRequestFailure);
    },
    [environment, view],
  );

  const profileEditing = useMemo<ProfileEditing>(
    () => ({
      save: (profile: LaunchProfile): void => {
        connection.request({ type: "saveLaunchProfile", profile }).catch(swallowRequestFailure);
      },
      remove: (profileID: LaunchProfileID): void => {
        connection.request({ type: "removeLaunchProfile", profileID }).catch(swallowRequestFailure);
      },
    }),
    [connection],
  );

  return (
    <>
      <SettingsSidebar tab={props.tab} onSelectTab={selectTab} onBack={back} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <SettingsPane
          tab={props.tab}
          settings={settings}
          onChangeSettings={changeSettings}
          profiles={profiles}
          availability={availability}
          profileEditing={profileEditing}
          sessions={sessions}
          terminalStates={terminalStates}
          service={environment.service}
        />
      </SidebarInset>
    </>
  );
}
