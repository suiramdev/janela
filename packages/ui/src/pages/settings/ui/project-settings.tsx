import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  AutomationEvent,
  AutomationScripts,
  Project,
  ProjectSettings,
  WorktreeRoot,
} from "@janela/core";
import {
  absolutePath,
  AUTOMATION_EVENTS,
  AUTOMATION_VARIABLES,
  supportsWorktrees,
} from "@janela/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ShellScriptEditor,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useId } from "react";

import {
  AUTOMATION_EVENT_HINT,
  automationViolations,
  usesTimeout,
  withAutomationScript,
  withAutomationTimeout,
} from "../model/automation-scripts.ts";
import {
  AUTOMATION_SECTION,
  PROJECT_AUTOMATION_SECTION,
  PROJECT_WORKTREES_SECTION,
  sectionElementID,
} from "../model/settings-index.ts";
import { type Choice, NumberRow, SelectRow, TextRow, Violations } from "./fields.tsx";
import { SettingBlock, SettingsGroup } from "./pane.tsx";

export interface ProjectSettingsPaneProps {
  readonly project: Project;
  readonly settings: ProjectSettings;
  readonly onChange: (settings: ProjectSettings) => void;
}

type WorktreeLocation = WorktreeRoot["kind"];

export const WORKTREE_LOCATION_CHOICES: readonly Choice<WorktreeLocation>[] = [
  { value: "siblingDirectory", title: "Beside the repository" },
  { value: "custom", title: "A directory I choose" },
];

export const AUTOMATION_HINT =
  "Each script runs in your login shell, in a terminal you can watch and interrupt. Scripts live here and are never read from the repository.";

const SCRIPT_PLACEHOLDER = `# Runs in your login shell, in the session's directory.
cp "$JANELA_PROJECT_DIRECTORY/.env" "$JANELA_SESSION_DIRECTORY/.env"`;

export function ProjectSettingsPane(props: ProjectSettingsPaneProps): ReactElement {
  const { project, settings, onChange } = props;
  const projectDirectory = project.directory;

  const changeLocation = useCallback(
    (location: WorktreeLocation) => {
      if (location === "siblingDirectory") {
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
      {supportsWorktrees(project) ? (
        <SettingsGroup section={PROJECT_WORKTREES_SECTION}>
          <SelectRow
            label="Location"
            description={
              settings.worktreeRoot.kind === "custom"
                ? undefined
                : "In .worktrees, which keeps paths short."
            }
            value={settings.worktreeRoot.kind}
            choices={WORKTREE_LOCATION_CHOICES}
            onChange={changeLocation}
          />
          {settings.worktreeRoot.kind === "custom" ? (
            <TextRow
              label="Directory"
              description="An absolute path."
              value={settings.worktreeRoot.directory}
              onChange={changeRootPath}
              isMonospaced
              isWide
            />
          ) : undefined}
        </SettingsGroup>
      ) : undefined}

      <SettingsGroup section={PROJECT_AUTOMATION_SECTION} description={AUTOMATION_HINT}>
        {AUTOMATION_EVENTS.map((event) => (
          <AutomationScriptBlock
            key={event}
            event={event}
            automation={settings.automation}
            onChange={changeAutomation}
          />
        ))}
        <AutomationVariables />
        <Violations violations={automationViolations(settings)} />
      </SettingsGroup>
    </>
  );
}

function AutomationVariables(): ReactElement {
  return (
    <Collapsible className="py-2.5">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs transition-colors">
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-3 transition-transform duration-150 group-data-[panel-open]:rotate-90"
        />
        Variables every script sees
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          {AUTOMATION_VARIABLES.map((variable) => (
            <div key={variable.name} className="contents">
              <dt className="font-mono">${variable.name}</dt>
              <dd className="text-muted-foreground">{variable.meaning}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AutomationScriptBlock(props: {
  readonly event: AutomationEvent;
  readonly automation: AutomationScripts;
  readonly onChange: (automation: AutomationScripts) => void;
}): ReactElement {
  const { event, automation, onChange } = props;
  const id = useId();
  const entry = automation[event];
  const section = AUTOMATION_SECTION[event];

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
    <SettingBlock
      label={section.title}
      description={AUTOMATION_EVENT_HINT[event]}
      controlID={id}
      sectionID={sectionElementID(section.id)}
    >
      <ShellScriptEditor
        id={id}
        value={entry?.script ?? ""}
        onChange={changeScript}
        placeholder={SCRIPT_PLACEHOLDER}
      />
      {usesTimeout(event) && entry !== undefined ? (
        <NumberRow
          label="Deletion timeout"
          value={entry.timeoutSeconds}
          onChange={changeTimeout}
          minimum={1}
          maximum={600}
          unit="seconds"
        />
      ) : undefined}
    </SettingBlock>
  );
}
