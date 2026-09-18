import type { ClientRequest } from "@janela/client";

import type { GlobalSettings, SettingsDraft, SettingsRoute } from "../../../shared/model/index.ts";
import { automationViolations } from "./automation-scripts.ts";

export interface DraftViolation {
  readonly route: SettingsRoute;
  readonly message: string;
}

export function draftViolations(draft: SettingsDraft): readonly DraftViolation[] {
  return draft.projects.flatMap((edit) =>
    automationViolations(edit.settings).map((message) => ({
      route: { kind: "project", projectID: edit.projectID } as const,
      message,
    })),
  );
}

export function settingsDraftRequests(
  draft: SettingsDraft,
  since: SettingsDraft,
): readonly ClientRequest[] {
  return draft.projects
    .filter((edit) => !since.projects.includes(edit))
    .map(
      (edit) =>
        ({
          type: "updateProjectSettings",
          projectID: edit.projectID,
          settings: edit.settings,
        }) as const,
    );
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
