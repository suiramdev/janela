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
import { NumberField, Section, SwitchField, TextField, Violations } from "./controls.tsx";
import { ProfileSelect } from "./launch-profile-picker.tsx";
import type { ArgumentDraft } from "./profile-editing.ts";
import { argumentDrafts, argvOf } from "./profile-editing.ts";
import * as style from "./styles.ts";

/**
 * A project's own settings, edited from its row in the sidebar.
 *
 * This is where automation commands come from. It is also the reason there is no
 * Projects tab in the settings window: these settings belong to a project, and the
 * place you edit a project is the project.
 *
 * ## The security property this preserves
 *
 * Automation commands exist **only** because a human typed them here. They are
 * never read from the repository, because a committed file that runs commands
 * makes cloning a repo from a stranger a code-execution vector — the one property
 * that cannot be added later. So this editor is not a convenience over a config
 * file; it is the whole mechanism.
 *
 * ## What it emits
 *
 * A whole `ProjectSettings`, which is what the `updateProjectSettings` message
 * already carries. Nothing is applied as you type: `onSave` is pressed once, so a
 * half-typed `pnpm ins` never reaches the daemon and never runs.
 */

export interface ProjectSettingsSheetProps {
  readonly project: Project;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly onSave: (settings: ProjectSettings) => void;
  readonly onCancel: () => void;
}

export function ProjectSettingsSheet(props: ProjectSettingsSheetProps): ReactElement {
  const { project, onSave } = props;
  const [draft, setDraft] = useState<ProjectSettings>(project.settings);
  const projectDirectory = project.directory;

  const changeDefaultProfile = useCallback((profileID: LaunchProfileID | undefined) => {
    setDraft((current) => {
      if (profileID === undefined) {
        const { defaultProfileID: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, defaultProfileID: profileID };
    });
  }, []);

  const changeForge = useCallback((isForgeEnabled: boolean) => {
    setDraft((current) => ({ ...current, isForgeEnabled }));
  }, []);

  const changeCustomRoot = useCallback(
    (isCustom: boolean) => {
      setDraft((current) => {
        if (!isCustom) return { ...current, worktreeRoot: { kind: "siblingDirectory" } };
        // The project's own directory is always absolute, so the field never opens
        // in an invalid state and the user edits from somewhere real.
        const directory =
          current.worktreeRoot.kind === "custom"
            ? current.worktreeRoot.directory
            : projectDirectory;
        return { ...current, worktreeRoot: { kind: "custom", directory } };
      });
    },
    [projectDirectory],
  );

  const changeRootPath = useCallback((path: string) => {
    setDraft((current) => {
      // Guarded rather than thrown: `absolutePath` refuses a relative path, and a
      // user halfway through typing `/Users/…` has one for a keystroke.
      if (!path.startsWith("/")) return current;
      return { ...current, worktreeRoot: { kind: "custom", directory: absolutePath(path) } };
    });
  }, []);

  const changeCommands = useCallback((automation: readonly AutomationCommand[]) => {
    setDraft((current) => ({ ...current, automation }));
  }, []);

  const save = useCallback(() => {
    onSave(draft);
  }, [draft, onSave]);

  const violations = draft.automation.flatMap((command) => automationViolations(command));

  return (
    <div style={style.PANE}>
      <Section title={project.name}>
        <ProfileSelect
          label="Default launch profile"
          profiles={props.profiles}
          availability={props.availability}
          value={draft.defaultProfileID}
          onChange={changeDefaultProfile}
          unsetTitle="Use the global default"
          hint="What this project's new sessions start in."
        />
        <SwitchField
          label="Read pull request and check state"
          isOn={draft.isForgeEnabled}
          onChange={changeForge}
          hint="Uses your own gh or glab. A missing or logged-out CLI means this is quietly absent, never an error."
        />
      </Section>

      {supportsWorktrees(project) ? (
        <Section title="Worktrees" hint="Where sessions cut from a branch are created.">
          <SwitchField
            label="Use a directory I choose"
            isOn={draft.worktreeRoot.kind === "custom"}
            onChange={changeCustomRoot}
            hint="Off puts them in .worktrees beside the repository, which keeps relative paths short — build tools embed them."
          />
          {draft.worktreeRoot.kind === "custom" ? (
            <TextField
              label="Worktree directory"
              value={draft.worktreeRoot.directory}
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
            commands={draft.automation}
            onChange={changeCommands}
          />
        ))}
      </Section>

      <Violations violations={violations} />

      <div style={style.ROW}>
        <button type="button" onClick={save} disabled={violations.length > 0} style={style.BUTTON}>
          Save
        </button>
        <button type="button" onClick={props.onCancel} style={style.BUTTON}>
          Cancel
        </button>
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
      {forEvent.length === 0 ? <p style={style.HINT}>Nothing runs.</p> : undefined}
      {forEvent.map((command) => (
        <AutomationCommandEditor
          key={command.id}
          command={command}
          onChange={replace}
          onRemove={remove}
          onMove={move}
        />
      ))}
      <div style={style.ROW}>
        <button type="button" onClick={append} style={style.BUTTON}>
          Add Command
        </button>
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
    <div style={style.FIELD}>
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

      <div style={style.ROW}>
        <button type="button" onClick={moveEarlier} style={style.BUTTON}>
          Run Earlier
        </button>
        <button type="button" onClick={moveLater} style={style.BUTTON}>
          Run Later
        </button>
        <button type="button" onClick={remove} style={style.DESTRUCTIVE_BUTTON}>
          Remove
        </button>
      </div>
    </div>
  );
}
