import type { LaunchProfile, LaunchProfileAvailability, LaunchProfileID } from "@janela/core";
import { isProfileAvailable } from "@janela/core";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { ArgumentsEditor } from "./argv-editor.tsx";
import { Section, SwitchField, TextField, Violations } from "./controls.tsx";
import type { ArgumentDraft, ProfileDraft, VariableDraft } from "./profile-editing.ts";
import {
  blankProfile,
  canRemoveProfile,
  canRenameProfile,
  duplicatedProfile,
  profileDraft,
  profileOf,
  profileViolations,
  variablesAppending,
} from "./profile-editing.ts";
import { PROFILE_ICON_NAMES, ProfileIcon } from "./profile-icons.tsx";
import * as style from "./styles.ts";

/**
 * The Profiles tab: authoring what ⌘T offers.
 *
 * ## Why unavailable profiles are visible *here*
 *
 * The picker hides a profile whose binary is missing. This pane shows it, with a
 * line saying so. That is not a contradiction: hiding exists so the user is never
 * offered something that cannot start, and this is the one surface where the
 * problem can be *fixed* — by correcting a typo in the executable, or pointing it
 * at an absolute path. A profile you cannot see is a profile you cannot repair.
 *
 * ## Built-ins
 *
 * Editable, not deletable, not renamable. Editable because the ones we ship are
 * guesses about the user's setup and they should be able to correct them in place;
 * the other two are consequences of seeding, which re-inserts built-ins by name on
 * every open. `canRemoveProfile` and `canRenameProfile` carry the reasoning.
 */

export interface ProfileEditing {
  save(profile: LaunchProfile): void;
  remove(profileID: LaunchProfileID): void;
}

export interface SettingsProfilesProps {
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly editing: ProfileEditing;
}

export function SettingsProfiles(props: SettingsProfilesProps): ReactElement {
  const { profiles, availability, editing } = props;
  const [draft, setDraft] = useState<ProfileDraft | undefined>(undefined);

  const selectedID = draft?.profile.id;

  const select = useCallback(
    (profileID: LaunchProfileID) => {
      const found = profiles.find((profile) => profile.id === profileID);
      setDraft(found === undefined ? undefined : profileDraft(found));
    },
    [profiles],
  );
  const add = useCallback(() => {
    setDraft(profileDraft(blankProfile()));
  }, []);
  const dismiss = useCallback(() => {
    setDraft(undefined);
  }, []);
  const save = useCallback(
    (saved: ProfileDraft) => {
      editing.save(profileOf(saved));
      setDraft(undefined);
    },
    [editing],
  );
  const remove = useCallback(
    (profileID: LaunchProfileID) => {
      editing.remove(profileID);
      setDraft(undefined);
    },
    [editing],
  );
  const duplicate = useCallback((profile: LaunchProfile) => {
    // Not saved yet: a copy the user has not named is a draft, and saving it on
    // the spot would put "Codex Copy" in their picker on a stray click.
    setDraft(profileDraft(duplicatedProfile(profile)));
  }, []);

  return (
    <div style={style.PANE}>
      <Section
        title="Launch profiles"
        hint="A profile is a command Janela starts in a terminal. It is not an integration: Janela does not wrap, parse or manage what it launches."
      >
        <ul style={style.LIST}>
          {profiles.map((profile) => (
            <ProfileListRow
              key={profile.id}
              profile={profile}
              isAvailable={isProfileAvailable(profile, availability)}
              isSelected={profile.id === selectedID}
              onSelect={select}
            />
          ))}
        </ul>
        <div style={style.ROW}>
          <button type="button" onClick={add} style={style.BUTTON}>
            New Profile
          </button>
        </div>
      </Section>

      {draft === undefined ? undefined : (
        <ProfileEditor
          draft={draft}
          isAvailable={isProfileAvailable(profileOf(draft), availability)}
          isKnown={profiles.some((profile) => profile.id === draft.profile.id)}
          onChange={setDraft}
          onSave={save}
          onRemove={remove}
          onDuplicate={duplicate}
          onCancel={dismiss}
        />
      )}
    </div>
  );
}

function ProfileListRow(props: {
  readonly profile: LaunchProfile;
  readonly isAvailable: boolean;
  readonly isSelected: boolean;
  readonly onSelect: (profileID: LaunchProfileID) => void;
}): ReactElement {
  const { profile, onSelect } = props;
  const select = useCallback(() => {
    onSelect(profile.id);
  }, [onSelect, profile.id]);

  const rowStyle = props.isSelected
    ? style.LIST_ROW_SELECTED
    : props.isAvailable
      ? style.LIST_ROW
      : style.UNAVAILABLE_ROW;

  return (
    <li>
      <button type="button" onClick={select} aria-pressed={props.isSelected} style={rowStyle}>
        <ProfileIcon iconName={profile.iconName} />
        <span>{profile.name}</span>
        {profile.isAgent ? <span style={style.HINT}>Agent</span> : undefined}
        {profile.isBuiltIn ? <span style={style.HINT}>Built-in</span> : undefined}
        {props.isAvailable ? undefined : (
          <span style={style.HINT}>Not on your PATH — hidden from the picker</span>
        )}
      </button>
    </li>
  );
}

/**
 * The editor for one profile.
 *
 * Exported so it can be rendered — and tested — without first driving a click
 * through the list above it.
 */
export function ProfileEditor(props: {
  readonly draft: ProfileDraft;
  readonly isAvailable: boolean;
  /** False for a new profile or an unsaved duplicate: there is nothing to delete. */
  readonly isKnown: boolean;
  readonly onChange: (draft: ProfileDraft) => void;
  readonly onSave: (draft: ProfileDraft) => void;
  readonly onRemove: (profileID: LaunchProfileID) => void;
  readonly onDuplicate: (profile: LaunchProfile) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { draft, onChange, onSave, onRemove, onDuplicate } = props;
  const { profile } = draft;
  const violations = profileViolations(profileOf(draft));

  const changeName = useCallback(
    (name: string) => {
      onChange({ ...draft, profile: { ...draft.profile, name } });
    },
    [draft, onChange],
  );
  const changeIcon = useCallback(
    (iconName: string) => {
      onChange({ ...draft, profile: { ...draft.profile, iconName } });
    },
    [draft, onChange],
  );
  const changeAgent = useCallback(
    (isAgent: boolean) => {
      onChange({ ...draft, profile: { ...draft.profile, isAgent } });
    },
    [draft, onChange],
  );
  const changeArguments = useCallback(
    (argumentDrafts: readonly ArgumentDraft[]) => {
      onChange({ ...draft, argumentDrafts });
    },
    [draft, onChange],
  );
  const changeVariables = useCallback(
    (variableDrafts: readonly VariableDraft[]) => {
      onChange({ ...draft, variableDrafts });
    },
    [draft, onChange],
  );
  const save = useCallback(() => {
    onSave(draft);
  }, [draft, onSave]);
  const remove = useCallback(() => {
    onRemove(profile.id);
  }, [onRemove, profile.id]);
  const duplicate = useCallback(() => {
    onDuplicate(profileOf(draft));
  }, [draft, onDuplicate]);

  const isRenamable = canRenameProfile(profile);

  return (
    <Section title={profile.name.trim().length === 0 ? "New profile" : profile.name}>
      <TextField
        label="Name"
        value={profile.name}
        onChange={changeName}
        isReadOnly={!isRenamable}
        hint={
          isRenamable
            ? undefined
            : "A built-in profile keeps its name. Duplicate it to make a copy you can rename."
        }
      />

      <IconChoice iconName={profile.iconName} onChange={changeIcon} />

      <ArgumentsEditor
        drafts={draft.argumentDrafts}
        onChange={changeArguments}
        title="Command"
        hint="The executable, then one field per argument. No shell runs, so quoting and spaces are never reinterpreted. Leave it empty for the login shell."
      />

      <VariablesEditor drafts={draft.variableDrafts} onChange={changeVariables} />

      <SwitchField
        label="Show as an agent"
        isOn={profile.isAgent}
        onChange={changeAgent}
        hint="A label only. It changes no behaviour, because Janela gives agents no special behaviour."
      />

      {props.isAvailable ? undefined : (
        <p style={style.HINT}>
          {draft.argumentDrafts[0]?.value ?? ""} is not on your PATH, so this profile is hidden from
          the picker. Give it an absolute path, or install it.
        </p>
      )}

      <Violations violations={violations} />

      <div style={style.ROW}>
        <button type="button" onClick={save} disabled={violations.length > 0} style={style.BUTTON}>
          Save
        </button>
        <button type="button" onClick={duplicate} style={style.BUTTON}>
          Duplicate
        </button>
        <button type="button" onClick={props.onCancel} style={style.BUTTON}>
          Cancel
        </button>
        {props.isKnown && canRemoveProfile(profile) ? (
          <button type="button" onClick={remove} style={style.DESTRUCTIVE_BUTTON}>
            Delete
          </button>
        ) : undefined}
      </div>
    </Section>
  );
}

/**
 * The icon grid.
 *
 * Real radio inputs, one per icon, so the browser owns arrow-key navigation
 * within the group and the roving tab stop — both of which a set of buttons with
 * `role="radio"` would have to reimplement, and would get subtly wrong.
 */
function IconChoice(props: {
  readonly iconName: string;
  readonly onChange: (iconName: string) => void;
}): ReactElement {
  return (
    <Section title="Icon">
      <div style={style.ROW}>
        {PROFILE_ICON_NAMES.map((iconName) => (
          <IconOption
            key={iconName}
            iconName={iconName}
            isSelected={iconName === props.iconName}
            onChange={props.onChange}
          />
        ))}
      </div>
    </Section>
  );
}

function IconOption(props: {
  readonly iconName: string;
  readonly isSelected: boolean;
  readonly onChange: (iconName: string) => void;
}): ReactElement {
  const { iconName, onChange } = props;
  const choose = useCallback(() => {
    onChange(iconName);
  }, [iconName, onChange]);

  return (
    <label style={props.isSelected ? style.LIST_ROW_SELECTED : style.LIST_ROW}>
      <input
        type="radio"
        name="profile-icon"
        value={iconName}
        checked={props.isSelected}
        onChange={choose}
      />
      <ProfileIcon iconName={iconName} />
      <span style={style.HINT}>{iconName}</span>
    </label>
  );
}

function VariablesEditor(props: {
  readonly drafts: readonly VariableDraft[];
  readonly onChange: (drafts: readonly VariableDraft[]) => void;
}): ReactElement {
  const { drafts, onChange } = props;

  const change = useCallback(
    (replacement: VariableDraft) => {
      onChange(drafts.map((draft) => (draft.id === replacement.id ? replacement : draft)));
    },
    [drafts, onChange],
  );
  const remove = useCallback(
    (id: string) => {
      onChange(drafts.filter((draft) => draft.id !== id));
    },
    [drafts, onChange],
  );
  const append = useCallback(() => {
    onChange(variablesAppending(drafts));
  }, [drafts, onChange]);

  return (
    <Section
      title="Environment"
      hint="Added on top of your shell environment. Not a place for secrets — those belong in your own shell configuration."
    >
      {drafts.map((draft) => (
        <VariableRow key={draft.id} draft={draft} onChange={change} onRemove={remove} />
      ))}
      <div style={style.ROW}>
        <button type="button" onClick={append} style={style.BUTTON}>
          Add Variable
        </button>
      </div>
    </Section>
  );
}

function VariableRow(props: {
  readonly draft: VariableDraft;
  readonly onChange: (draft: VariableDraft) => void;
  readonly onRemove: (id: string) => void;
}): ReactElement {
  const { draft, onChange, onRemove } = props;
  const changeKey = useCallback(
    (key: string) => {
      onChange({ id: draft.id, key, value: draft.value });
    },
    [draft.id, draft.value, onChange],
  );
  const changeValue = useCallback(
    (value: string) => {
      onChange({ id: draft.id, key: draft.key, value });
    },
    [draft.id, draft.key, onChange],
  );
  const remove = useCallback(() => {
    onRemove(draft.id);
  }, [draft.id, onRemove]);

  return (
    <div style={style.ROW}>
      <TextField label="Name" value={draft.key} onChange={changeKey} isMonospaced />
      <TextField label="Value" value={draft.value} onChange={changeValue} isMonospaced />
      <button
        type="button"
        onClick={remove}
        style={style.BUTTON}
        aria-label={`Remove ${draft.key}`}
      >
        Remove
      </button>
    </div>
  );
}
