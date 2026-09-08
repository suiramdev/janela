import type {
  LaunchProfile,
  LaunchProfileAvailability,
  Session,
  TerminalID,
  TerminalState,
} from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import type { BackgroundServiceControlling } from "./background-service.ts";
import type { GlobalSettings } from "./global-settings.ts";
import { ProfileIcon } from "./profile-icons.tsx";
import { SettingsGeneral } from "./settings-general.tsx";
import { SettingsNotifications } from "./settings-notifications.tsx";
import { SettingsProfiles, type ProfileEditing } from "./settings-profiles.tsx";
import { SettingsTerminal } from "./settings-terminal.tsx";
import * as style from "./styles.ts";

/**
 * The settings surface: four tabs.
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
 * Same reason `COMMANDS` is: the tab strip and anything that opens a specific tab
 * (a menu item, a deep link from a banner) read one table, so they cannot drift.
 */

export type SettingsTabID = "general" | "terminal" | "profiles" | "notifications";

export interface SettingsTab {
  readonly id: SettingsTabID;
  readonly title: string;
  /** A Lucide name, resolved through the same fallback a profile's icon uses. */
  readonly iconName: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", title: "General", iconName: "wrench" },
  { id: "terminal", title: "Terminal", iconName: "terminal" },
  { id: "profiles", title: "Profiles", iconName: "sparkles" },
  { id: "notifications", title: "Notifications", iconName: "bell" },
];

export interface SettingsWindowProps {
  readonly settings: GlobalSettings;
  readonly onChangeSettings: (settings: GlobalSettings) => void;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly profileEditing: ProfileEditing;
  /** The mirror's sessions, for the background service's stated cost. */
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling;
  /** Opens on a specific tab — how a banner sends someone straight to Profiles. */
  readonly initialTab?: SettingsTabID;
}

export function SettingsWindow(props: SettingsWindowProps): ReactElement {
  const [tab, setTab] = useState<SettingsTabID>(props.initialTab ?? "general");

  return (
    <div style={style.WINDOW}>
      <div style={style.TAB_STRIP} role="tablist" aria-label="Settings">
        {SETTINGS_TABS.map((entry) => (
          <TabButton key={entry.id} tab={entry} isSelected={entry.id === tab} onSelect={setTab} />
        ))}
      </div>
      <div role="tabpanel" aria-label={titleOf(tab)} style={style.WINDOW}>
        <SettingsPane {...props} tab={tab} />
      </div>
    </div>
  );
}

function titleOf(id: SettingsTabID): string {
  return SETTINGS_TABS.find((tab) => tab.id === id)?.title ?? "Settings";
}

function SettingsPane(props: SettingsWindowProps & { readonly tab: SettingsTabID }): ReactElement {
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

function TabButton(props: {
  readonly tab: SettingsTab;
  readonly isSelected: boolean;
  readonly onSelect: (id: SettingsTabID) => void;
}): ReactElement {
  const { tab, onSelect } = props;
  const select = useCallback(() => {
    onSelect(tab.id);
  }, [onSelect, tab.id]);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.isSelected}
      onClick={select}
      style={props.isSelected ? style.TAB_SELECTED : style.TAB}
    >
      <ProfileIcon iconName={tab.iconName} size={18} />
      <span>{tab.title}</span>
    </button>
  );
}
