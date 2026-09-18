import type { Project, ProjectID, ProjectSettings } from "@janela/core";

import type { GlobalSettings } from "./global-settings.ts";

export interface ProjectSettingsEdit {
  readonly projectID: ProjectID;
  readonly settings: ProjectSettings;
}

export interface SettingsDraft {
  readonly settings: GlobalSettings | undefined;
  readonly projects: readonly ProjectSettingsEdit[];
}

export const EMPTY_SETTINGS_DRAFT: SettingsDraft = {
  settings: undefined,
  projects: [],
};

export function draftSettings(draft: SettingsDraft, stored: GlobalSettings): GlobalSettings {
  return draft.settings ?? stored;
}

export function withDraftSettings(draft: SettingsDraft, settings: GlobalSettings): SettingsDraft {
  return { ...draft, settings };
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
