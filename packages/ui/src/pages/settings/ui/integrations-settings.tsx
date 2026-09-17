import type { Forge, LaunchProfile, LaunchProfileAvailability, Project } from "@janela/core";
import { forgeExecutable } from "@janela/core";
import { FieldDescription } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type GlobalSettings,
  type SettingsDraft,
  draftProjectSettings,
  withDraftProjectSettings,
} from "../../../shared/model/index.ts";
import { FORGE_SECTION } from "../model/settings-index.ts";
import { SwitchField } from "./fields.tsx";
import { SettingsProfiles } from "./launch-profiles.tsx";
import { Section } from "./pane.tsx";

export interface SettingsIntegrationsProps {
  readonly projects: readonly Project[];
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly settings: GlobalSettings;
  readonly onChangeSettings: (settings: GlobalSettings) => void;
  readonly draft: SettingsDraft;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

interface HostedProject {
  readonly project: Project;
  readonly forge: Forge;
}

const FORGE_TITLE = { gitHub: "GitHub", gitLab: "GitLab" } as const;

function hostedProjects(projects: readonly Project[]): readonly HostedProject[] {
  return projects.flatMap((project) => {
    const forge = project.git?.forge;

    return forge === undefined ? [] : [{ project, forge }];
  });
}

export function SettingsIntegrations(props: SettingsIntegrationsProps): ReactElement {
  const { projects, draft, onChangeDraft } = props;
  const hosted = hostedProjects(projects);

  const changeForge = useCallback(
    (project: Project, isForgeEnabled: boolean) => {
      onChangeDraft(
        withDraftProjectSettings(draft, project.id, {
          ...draftProjectSettings(draft, project),
          isForgeEnabled,
        }),
      );
    },
    [draft, onChangeDraft],
  );

  return (
    <>
      <Section section={FORGE_SECTION}>
        {hosted.length === 0 ? (
          <FieldDescription>No project is hosted on GitHub or GitLab.</FieldDescription>
        ) : undefined}
        {hosted.map(({ project, forge }) => (
          <ForgeSwitch
            key={project.id}
            project={project}
            forge={forge}
            isOn={draftProjectSettings(draft, project).isForgeEnabled}
            onChange={changeForge}
          />
        ))}
      </Section>

      <SettingsProfiles
        profiles={props.profiles}
        availability={props.availability}
        settings={props.settings}
        onChangeSettings={props.onChangeSettings}
        draft={draft}
        onChangeDraft={onChangeDraft}
      />
    </>
  );
}

function ForgeSwitch(props: {
  readonly project: Project;
  readonly forge: Forge;
  readonly isOn: boolean;
  readonly onChange: (project: Project, isOn: boolean) => void;
}): ReactElement {
  const { project, forge, onChange } = props;

  const change = useCallback(
    (isOn: boolean) => {
      onChange(project, isOn);
    },
    [onChange, project],
  );

  return (
    <SwitchField
      label={project.name}
      isOn={props.isOn}
      onChange={change}
      hint={`Read pull request and check state from ${FORGE_TITLE[forge]}, through ${forgeExecutable(forge)}.`}
    />
  );
}
