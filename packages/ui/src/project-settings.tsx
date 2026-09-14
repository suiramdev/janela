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
import { Button, ButtonGroup, Empty, EmptyDescription, EmptyHeader, Item } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { ArgumentsEditor } from "./argv-editor.tsx";
import {
  AUTOMATION_EVENT_HINT,
  AUTOMATION_EVENT_TITLE,
  automationAppending,
  automationMoving,
  automationRemoving,
  automationReplacing,
  automationViolations,
  commandsForEvent,
  usesTimeout,
} from "./automation-editing.ts";
import {
  NumberField,
  ProfileSelect,
  Section,
  SwitchField,
  TextField,
  Violations,
} from "./controls.tsx";
import type { ArgumentDraft } from "./profile-editing.ts";
import { argumentDrafts, argvOf } from "./profile-editing.ts";
import { PANE_COLUMN } from "./window-chrome.tsx";

/**
 * One project's settings, as the Projects section's pane.
 *
 * This is where automation commands come from.
 *
 * ## The security property this preserves
 *
 * Automation commands exist **only** because a human typed them here. They are
 * never read from the repository, because a committed file that runs commands
 * makes cloning a repo from a stranger a code-execution vector — the one property
 * that cannot be added later. So this editor is not a convenience over a config
 * file; it is the whole mechanism.
 *
 * ## Why it holds no state of its own
 *
 * Every edit goes straight out through `onChange` into the screen's draft, and
 * the value comes back down through `settings`. The pane is the most obvious
 * reason the draft exists — a field applied per keystroke would send `pnpm ins`
 * to the daemon, which stores commands that *run* — but it is not the owner of
 * it: the Save and Revert that commit this form are the same pair that commit
 * every other tab, and they live with the draft in `SettingsScreen`.
 */

export interface ProjectSettingsPaneProps {
  readonly project: Project;
  /** The draft's value for this project, which is the mirror's until it is edited. */
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

  const changeForge = useCallback(
    (isForgeEnabled: boolean) => {
      onChange({ ...settings, isForgeEnabled });
    },
    [onChange, settings],
  );

  const changeCustomRoot = useCallback(
    (isCustom: boolean) => {
      if (!isCustom) {
        onChange({ ...settings, worktreeRoot: { kind: "siblingDirectory" } });
        return;
      }
      // The project's own directory is always absolute, so the field never opens
      // in an invalid state and the user edits from somewhere real.
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
      // Guarded rather than thrown: `absolutePath` refuses a relative path, and a
      // user halfway through typing `/Users/…` has one for a keystroke.
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
    <div className={PANE_COLUMN}>
      <h2 className="text-base font-semibold">{project.name}</h2>
      {/* The directory under the name: two clones of one repository are two
          projects with the same name, and the path is the only thing that
          tells them apart. */}
      <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{project.directory}</p>
      <div className="mt-5 flex flex-col gap-6">
        <Section title="General">
          <ProfileSelect
            label="Default launch profile"
            profiles={props.profiles}
            availability={props.availability}
            value={settings.defaultProfileID}
            onChange={changeDefaultProfile}
            unsetTitle="Use the global default"
            hint="What this project's new sessions start in."
          />
          <SwitchField
            label="Read pull request and check state"
            isOn={settings.isForgeEnabled}
            onChange={changeForge}
            hint="Uses your own gh or glab. A missing or logged-out CLI means this is quietly absent, never an error."
          />
        </Section>

        {supportsWorktrees(project) ? (
          <Section title="Worktrees" hint="Where sessions cut from a branch are created.">
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

        <Section
          title="Automation"
          hint="Commands Janela runs for you, each in a real terminal in the session you can watch and interrupt. They are stored here and never read from the repository."
        >
          {AUTOMATION_EVENTS.map((event) => (
            <AutomationEventSection
              key={event}
              event={event}
              commands={settings.automation}
              onChange={changeCommands}
            />
          ))}
        </Section>

        <Violations violations={violations} />
      </div>
    </div>
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
    <Section title={AUTOMATION_EVENT_TITLE[event]} hint={AUTOMATION_EVENT_HINT[event]}>
      {forEvent.length === 0 ? (
        <Empty className="p-4">
          <EmptyHeader>
            <EmptyDescription>Nothing runs.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : undefined}
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

  // The argv drafts are local, initialised once from the command. They give each
  // field a stable identity so removing argument 1 of three does not remount the
  // others and drop the caret; nothing else edits this command while the sheet is
  // open, so there is nothing to synchronise back down.
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

      {/* The order controls are one control with two directions, so they read as
          one; Remove is not, and stands apart from them. */}
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
