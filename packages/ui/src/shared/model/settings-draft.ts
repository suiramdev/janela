import type {
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  ProjectSettings,
} from "@janela/core";

import type { GlobalSettings } from "./global-settings.ts";
import { type ProfileDraft, profileOf } from "./profile-draft.ts";

export interface ProjectSettingsEdit {
  readonly projectID: ProjectID;
  readonly settings: ProjectSettings;
}

export interface SettingsDraft {
  readonly settings: GlobalSettings | undefined;
  readonly profiles: readonly ProfileDraft[];
  readonly removedProfileIDs: readonly LaunchProfileID[];
  readonly projects: readonly ProjectSettingsEdit[];
}

export const EMPTY_SETTINGS_DRAFT: SettingsDraft = {
  settings: undefined,
  profiles: [],
  removedProfileIDs: [],
  projects: [],
};

export function draftSettings(draft: SettingsDraft, stored: GlobalSettings): GlobalSettings {
  return draft.settings ?? stored;
}

export function withDraftSettings(draft: SettingsDraft, settings: GlobalSettings): SettingsDraft {
  return { ...draft, settings };
}

export function draftProfiles(
  draft: SettingsDraft,
  stored: readonly LaunchProfile[],
): readonly LaunchProfile[] {
  const kept = stored
    .filter((profile) => !draft.removedProfileIDs.includes(profile.id))
    .map((profile) => {
      const edit = draft.profiles.find((entry) => entry.profile.id === profile.id);

      return edit === undefined ? profile : profileOf(edit);
    });

  const added = draft.profiles
    .filter((entry) => !stored.some((profile) => profile.id === entry.profile.id))
    .map(profileOf);

  return [...kept, ...added];
}

export function withDraftProfile(draft: SettingsDraft, edited: ProfileDraft): SettingsDraft {
  const known = draft.profiles.some((entry) => entry.profile.id === edited.profile.id);

  return {
    ...draft,
    profiles: known
      ? draft.profiles.map((entry) => (entry.profile.id === edited.profile.id ? edited : entry))
      : [...draft.profiles, edited],
  };
}

export function withoutDraftProfile(
  draft: SettingsDraft,
  profileID: LaunchProfileID,
  stored: readonly LaunchProfile[],
): SettingsDraft {
  const withoutEdit = draft.profiles.filter((entry) => entry.profile.id !== profileID);

  if (!stored.some((profile) => profile.id === profileID)) {
    return { ...draft, profiles: withoutEdit };
  }

  return {
    ...draft,
    profiles: withoutEdit,
    removedProfileIDs: draft.removedProfileIDs.includes(profileID)
      ? draft.removedProfileIDs
      : [...draft.removedProfileIDs, profileID],
  };
}

export function draftProjectSettings(draft: SettingsDraft, project: Project): ProjectSettings {
  const edit = draft.projects.find((candidate) => candidate.projectID === project.id);

  return edit?.settings ?? project.settings;
}

export function withDraftProjectSettings(
  draft: SettingsDraft,
  projectID: ProjectID,
  settings: ProjectSettings,
): SettingsDraft {
  const known = draft.projects.some((edit) => edit.projectID === projectID);

  return {
    ...draft,
    projects: known
      ? draft.projects.map((edit) =>
          edit.projectID === projectID ? { projectID, settings } : edit,
        )
      : [...draft.projects, { projectID, settings }],
  };
}
