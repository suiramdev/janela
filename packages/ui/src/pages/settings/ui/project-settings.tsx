import type {
  AutomationEvent,
  AutomationScripts,
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Project,
  ProjectSettings,
} from "@janela/core";
import {
  absolutePath,
  AUTOMATION_EVENTS,
  AUTOMATION_VARIABLES,
  supportsWorktrees,
} from "@janela/core";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  ShellScriptEditor,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useId } from "react";

import {
  automationViolations,
  usesTimeout,
  withAutomationScript,
  withAutomationTimeout,
} from "../model/automation-scripts.ts";
import {
  AUTOMATION_SECTION,
  PROJECT_AUTOMATION_SECTION,
  PROJECT_SESSIONS_SECTION,
  PROJECT_WORKTREES_SECTION,
} from "../model/settings-index.ts";
import { NumberField, ProfileSelect, SwitchField, TextField, Violations } from "./fields.tsx";
import { PaneGroup, Section } from "./pane.tsx";

export interface ProjectSettingsPaneProps {
  readonly project: Project;
  readonly settings: ProjectSettings;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly onChange: (settings: ProjectSettings) => void;
}

const SCRIPT_PLACEHOLDER = `# Runs in your login shell, in the session's directory.
cp "$JANELA_PROJECT_DIRECTORY/.env" "$JANELA_SESSION_DIRECTORY/.env"`;

export function ProjectSettingsPane(props: ProjectSettingsPaneProps): ReactElement {
  const { project, settings, onChange } = props;
  const projectDirectory = project.directory;

  const changeDefaultProfile = useCallback(
    (profileID: LaunchProfileID | undefined) => {
      if (profileID === undefined) {
        const { defaultProfileID: _removed, ...rest } = settings;
        onChange(rest);

        return;
      }

      onChange({ ...settings, defaultProfileID: profileID });
    },
    [onChange, settings],
  );

  const changeCustomRoot = useCallback(
    (isCustom: boolean) => {
      if (!isCustom) {
        onChange({ ...settings, worktreeRoot: { kind: "siblingDirectory" } });

        return;
      }

      const directory =
        settings.worktreeRoot.kind === "custom"
          ? settings.worktreeRoot.directory
          : projectDirectory;

      onChange({ ...settings, worktreeRoot: { kind: "custom", directory } });
    },
    [onChange, projectDirectory, settings],
  );

  const changeRootPath = useCallback(
    (path: string) => {
      if (!path.startsWith("/")) return;

      onChange({
        ...settings,
        worktreeRoot: { kind: "custom", directory: absolutePath(path) },
      });
    },
    [onChange, settings],
  );

  const changeAutomation = useCallback(
    (automation: AutomationScripts) => {
      onChange({ ...settings, automation });
    },
    [onChange, settings],
  );

  return (
    <>
      <Section section={PROJECT_SESSIONS_SECTION}>
        <ProfileSelect
          label="Default launch profile"
          profiles={props.profiles}
          availability={props.availability}
          value={settings.defaultProfileID}
          onChange={changeDefaultProfile}
          unsetTitle="Use the global default"
          hint="What this project's new sessions start in."
        />
      </Section>

      {supportsWorktrees(project) ? (
        <Section section={PROJECT_WORKTREES_SECTION}>
          <SwitchField
            label="Use a directory I choose"
            isOn={settings.worktreeRoot.kind === "custom"}
            onChange={changeCustomRoot}
            hint="Off puts them in .worktrees beside the repository, which keeps relative paths short — build tools embed them."
          />
          {settings.worktreeRoot.kind === "custom" ? (
            <TextField
              label="Worktree directory"
              value={settings.worktreeRoot.directory}
              onChange={changeRootPath}
              isMonospaced
              hint="Must be an absolute path."
            />
          ) : undefined}
        </Section>
      ) : undefined}

      <PaneGroup section={PROJECT_AUTOMATION_SECTION}>
        <AutomationVariables />
        {AUTOMATION_EVENTS.map((event) => (
          <AutomationScriptSection
            key={event}
            event={event}
            automation={settings.automation}
            onChange={changeAutomation}
          />
        ))}
        <Violations violations={automationViolations(settings)} />
      </PaneGroup>
    </>
  );
}

function AutomationVariables(): ReactElement {
  return (
    <div className="px-1">
      <FieldDescription>
        Every script sees these, on top of your shell&apos;s own environment:
      </FieldDescription>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {AUTOMATION_VARIABLES.map((variable) => (
          <div key={variable.name} className="contents">
            <dt className="font-mono">${variable.name}</dt>
            <dd className="text-muted-foreground">{variable.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AutomationScriptSection(props: {
  readonly event: AutomationEvent;
  readonly automation: AutomationScripts;
  readonly onChange: (automation: AutomationScripts) => void;
}): ReactElement {
  const { event, automation, onChange } = props;
  const id = useId();
  const entry = automation[event];

  const changeScript = useCallback(
    (script: string) => {
      onChange(withAutomationScript(automation, event, script));
    },
    [automation, event, onChange],
  );

  const changeTimeout = useCallback(
    (timeoutSeconds: number) => {
      onChange(withAutomationTimeout(automation, event, timeoutSeconds));
    },
    [automation, event, onChange],
  );

  return (
    <Section section={AUTOMATION_SECTION[event]}>
      <Field>
        <FieldContent>
          <FieldLabel htmlFor={id}>Script</FieldLabel>
          <FieldDescription>
            Leave it empty and nothing runs. Lines starting with # are comments.
          </FieldDescription>
        </FieldContent>
        <ShellScriptEditor
          id={id}
          value={entry?.script ?? ""}
          onChange={changeScript}
          placeholder={SCRIPT_PLACEHOLDER}
        />
      </Field>

      {usesTimeout(event) && entry !== undefined ? (
        <NumberField
          label="Deletion waits this long"
          value={entry.timeoutSeconds}
          onChange={changeTimeout}
          minimum={1}
          maximum={600}
          hint="Seconds. Past it you are asked once whether to wait — deleting a session never hangs on a script."
        />
      ) : undefined}
    </Section>
  );
}
