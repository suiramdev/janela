import { ArrowDown01Icon, ArrowUp01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  AutomationCommand,
  AutomationEvent,
  AutomationID,
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Project,
  ProjectSettings,
} from "@janela/core";
import { absolutePath, AUTOMATION_EVENTS, supportsWorktrees } from "@janela/core";
import { Button, ButtonGroup, FieldDescription, Item } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { type ArgumentDraft, argumentDrafts, argvOf } from "../../../shared/model/index.ts";
import {
  automationAppending,
  automationMoving,
  automationRemoving,
  automationReplacing,
  automationViolations,
  commandsForEvent,
  usesTimeout,
} from "../model/automation-commands.ts";
import {
  AUTOMATION_SECTION,
  PROJECT_AUTOMATION_SECTION,
  PROJECT_SESSIONS_SECTION,
  PROJECT_WORKTREES_SECTION,
} from "../model/settings-index.ts";
import { ArgumentsEditor } from "./argv-editor.tsx";
import { NumberField, ProfileSelect, SwitchField, TextField, Violations } from "./fields.tsx";
import { PaneGroup, Section } from "./pane.tsx";

export interface ProjectSettingsPaneProps {
  readonly project: Project;
  readonly settings: ProjectSettings;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly onChange: (settings: ProjectSettings) => void;
}

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

  const changeCommands = useCallback(
    (automation: readonly AutomationCommand[]) => {
      onChange({ ...settings, automation });
    },
    [onChange, settings],
  );

  const violations = settings.automation.flatMap((command) => automationViolations(command));

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
        {AUTOMATION_EVENTS.map((event) => (
          <AutomationEventSection
            key={event}
            event={event}
            commands={settings.automation}
            onChange={changeCommands}
          />
        ))}
        <Violations violations={violations} />
      </PaneGroup>
    </>
  );
}

function AutomationEventSection(props: {
  readonly event: AutomationEvent;
  readonly commands: readonly AutomationCommand[];
  readonly onChange: (commands: readonly AutomationCommand[]) => void;
}): ReactElement {
  const { event, commands, onChange } = props;
  const forEvent = useMemo(() => commandsForEvent(commands, event), [commands, event]);

  const append = useCallback(() => {
    onChange(automationAppending(commands, event));
  }, [commands, event, onChange]);

  const replace = useCallback(
    (command: AutomationCommand) => {
      onChange(automationReplacing(commands, command));
    },
    [commands, onChange],
  );

  const remove = useCallback(
    (id: AutomationID) => {
      onChange(automationRemoving(commands, id));
    },
    [commands, onChange],
  );

  const move = useCallback(
    (id: AutomationID, delta: -1 | 1) => {
      onChange(automationMoving(commands, id, delta));
    },
    [commands, onChange],
  );

  return (
    <Section section={AUTOMATION_SECTION[event]}>
      {forEvent.length === 0 ? <FieldDescription>Nothing runs.</FieldDescription> : undefined}
      {forEvent.map((command) => (
        <AutomationCommandEditor
          key={command.id}
          command={command}
          onChange={replace}
          onRemove={remove}
          onMove={move}
        />
      ))}
      <div className="flex">
        <Button variant="outline" size="sm" onClick={append}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          Add Command
        </Button>
      </div>
    </Section>
  );
}

function AutomationCommandEditor(props: {
  readonly command: AutomationCommand;
  readonly onChange: (command: AutomationCommand) => void;
  readonly onRemove: (id: AutomationID) => void;
  readonly onMove: (id: AutomationID, delta: -1 | 1) => void;
}): ReactElement {
  const { command, onChange, onRemove, onMove } = props;

  const [drafts, setDrafts] = useState<readonly ArgumentDraft[]>(() =>
    argumentDrafts(command.command),
  );

  const changeArguments = useCallback(
    (next: readonly ArgumentDraft[]) => {
      setDrafts(next);
      onChange({ ...command, command: argvOf(next) });
    },
    [command, onChange],
  );

  const changeEnabled = useCallback(
    (isEnabled: boolean) => {
      onChange({ ...command, isEnabled });
    },
    [command, onChange],
  );

  const changeTimeout = useCallback(
    (timeoutSeconds: number) => {
      onChange({
        ...command,
        timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 0,
      });
    },
    [command, onChange],
  );

  const remove = useCallback(() => {
    onRemove(command.id);
  }, [command.id, onRemove]);

  const moveEarlier = useCallback(() => {
    onMove(command.id, -1);
  }, [command.id, onMove]);

  const moveLater = useCallback(() => {
    onMove(command.id, 1);
  }, [command.id, onMove]);

  return (
    <Item variant="outline" className="flex-col items-stretch gap-3">
      <SwitchField
        label="Enabled"
        isOn={command.isEnabled}
        onChange={changeEnabled}
        hint="New commands start disabled, so nothing runs because you added a row to read it."
      />

      <ArgumentsEditor
        drafts={drafts}
        onChange={changeArguments}
        title="Command"
        hint="The executable, then one field per argument. No shell runs, so nothing is re-quoted."
      />

      {usesTimeout(command.event) ? (
        <NumberField
          label="Deletion waits this long"
          value={command.timeoutSeconds}
          onChange={changeTimeout}
          minimum={1}
          maximum={600}
          hint="Seconds. Past it you are asked once whether to wait — deleting a session never hangs on a script."
        />
      ) : undefined}

      <Violations violations={automationViolations(command)} />

      <div className="flex items-center justify-end gap-2">
        <ButtonGroup>
          <Button variant="outline" size="sm" onClick={moveEarlier} aria-label="Run Earlier">
            <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          </Button>
          <Button variant="outline" size="sm" onClick={moveLater} aria-label="Run Later">
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          </Button>
        </ButtonGroup>
        <Button variant="destructive" size="sm" onClick={remove}>
          Remove
        </Button>
      </div>
    </Item>
  );
}
