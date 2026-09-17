import type { ClientRequest } from "@janela/client";

import {
  type GlobalSettings,
  type SettingsDraft,
  type SettingsRoute,
  profileOf,
} from "../../../shared/model/index.ts";
import { automationViolations } from "./automation-commands.ts";
import { profileViolations } from "./profile-rules.ts";

export interface DraftViolation {
  readonly route: SettingsRoute;
  readonly message: string;
}

const PROFILES_ROUTE: SettingsRoute = { kind: "tab", tab: "integrations" };

export function draftViolations(draft: SettingsDraft): readonly DraftViolation[] {
  const profiles = draft.profiles.flatMap((entry) =>
    profileViolations(profileOf(entry)).map((message) => ({ route: PROFILES_ROUTE, message })),
  );

  const projects = draft.projects.flatMap((edit) =>
    edit.settings.automation.flatMap((command) =>
      automationViolations(command).map((message) => ({
        route: { kind: "project", projectID: edit.projectID } as const,
        message,
      })),
    ),
  );

  return [...profiles, ...projects];
}

export function settingsDraftRequests(
  draft: SettingsDraft,
  since: SettingsDraft,
): readonly ClientRequest[] {
  return [
    ...draft.profiles
      .filter((entry) => !since.profiles.includes(entry))
      .map((entry) => ({ type: "saveLaunchProfile", profile: profileOf(entry) }) as const),
    ...draft.removedProfileIDs
      .filter((profileID) => !since.removedProfileIDs.includes(profileID))
      .map((profileID) => ({ type: "removeLaunchProfile", profileID }) as const),
    ...draft.projects
      .filter((edit) => !since.projects.includes(edit))
      .map(
        (edit) =>
          ({
            type: "updateProjectSettings",
            projectID: edit.projectID,
            settings: edit.settings,
          }) as const,
      ),
  ];
}

export function draftSettingsToSave(
  draft: SettingsDraft,
  since: SettingsDraft,
): GlobalSettings | undefined {
  if (draft.settings === undefined || draft.settings === since.settings) return undefined;

  return draft.settings;
}

export function draftEditCount(draft: SettingsDraft, since: SettingsDraft): number {
  return (
    (draftSettingsToSave(draft, since) === undefined ? 0 : 1) +
    settingsDraftRequests(draft, since).length
  );
}
