import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LaunchProfile, LaunchProfileAvailability, LaunchProfileID } from "@janela/core";
import { isProfileAvailable } from "@janela/core";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  FieldLabel,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  RadioGroup,
  RadioGroupItem,
  cn,
} from "@janela/design";
import type { ReactElement } from "react";
import { useCallback, useId, useState } from "react";

import { PROFILE_ICON_NAMES } from "../../../shared/config/index.ts";
import {
  type ArgumentDraft,
  type ProfileDraft,
  type SettingsDraft,
  type VariableDraft,
  blankProfile,
  draftProfiles,
  profileDraft,
  profileOf,
  variablesAppending,
  withDraftProfile,
  withoutDraftProfile,
} from "../../../shared/model/index.ts";
import {
  canRemoveProfile,
  canRenameProfile,
  duplicatedProfile,
  profileTitle,
  profileViolations,
} from "../model/profile-rules.ts";
import { ArgumentsEditor } from "./argv-editor.tsx";
import { Section, SwitchField, TextField, Violations } from "./fields.tsx";
import { ProfileIcon } from "./profile-icon.tsx";

export interface SettingsProfilesProps {
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly draft: SettingsDraft;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

// oxlint-disable-next-line jsx-a11y/control-has-associated-label -- an empty template: `Item` renders it with the row's children, which is where its label comes from (docs/packages/ui.md § launch-profiles.tsx)
const PROFILE_ROW = <button type="button" />;

export function SettingsProfiles(props: SettingsProfilesProps): ReactElement {
  const { profiles, availability, draft, onChangeDraft } = props;
  const [editor, setEditor] = useState<ProfileDraft | undefined>(undefined);

  const listed = draftProfiles(draft, profiles);
  const selectedID = editor?.profile.id;

  const select = useCallback(
    (profileID: LaunchProfileID) => {
      const found = listed.find((profile) => profile.id === profileID);
      setEditor(found === undefined ? undefined : profileDraft(found));
    },
    [listed],
  );

  const change = useCallback(
    (next: ProfileDraft) => {
      setEditor(next);
      onChangeDraft(withDraftProfile(draft, next));
    },
    [draft, onChangeDraft],
  );

  const add = useCallback(() => {
    change(profileDraft(blankProfile()));
  }, [change]);

  const duplicate = useCallback(
    (profile: LaunchProfile) => {
      change(profileDraft(duplicatedProfile(profile)));
    },
    [change],
  );

  const remove = useCallback(
    (profileID: LaunchProfileID) => {
      setEditor(undefined);
      onChangeDraft(withoutDraftProfile(draft, profileID, profiles));
    },
    [draft, onChangeDraft, profiles],
  );

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Launch profiles"
        hint="A profile is a command Janela starts in a terminal. It is not an integration: Janela does not wrap, parse or manage what it launches."
      >
        <ItemGroup>
          {listed.map((profile) => (
            <ProfileListRow
              key={profile.id}
              profile={profile}
              isAvailable={isProfileAvailable(profile, availability)}
              isSelected={profile.id === selectedID}
              onSelect={select}
            />
          ))}
        </ItemGroup>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            New Profile
          </Button>
        </div>
      </Section>

      {editor === undefined ? undefined : (
        <ProfileEditor
          draft={editor}
          isAvailable={isProfileAvailable(profileOf(editor), availability)}
          isStored={profiles.some((profile) => profile.id === editor.profile.id)}
          onChange={change}
          onRemove={remove}
          onDuplicate={duplicate}
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

  return (
    <Item
      render={PROFILE_ROW}
      size="sm"
      variant="outline"
      onClick={select}
      aria-pressed={props.isSelected}
      className={cn(
        "text-left",
        props.isSelected && "bg-accent text-accent-foreground",
        !props.isAvailable && "opacity-60",
      )}
    >
      <ItemMedia variant="icon">
        <ProfileIcon iconName={profile.iconName} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{profileTitle(profile)}</ItemTitle>
      </ItemContent>
      <ItemActions>
        {profile.isAgent ? <Badge variant="secondary">Agent</Badge> : undefined}
        {profile.isBuiltIn ? <Badge variant="outline">Built-in</Badge> : undefined}
        {props.isAvailable ? undefined : (
          <Badge variant="destructive">Not on your PATH — hidden from the picker</Badge>
        )}
      </ItemActions>
    </Item>
  );
}

export function ProfileEditor(props: {
  readonly draft: ProfileDraft;
  readonly isAvailable: boolean;
  readonly isStored: boolean;
  readonly onChange: (draft: ProfileDraft) => void;
  readonly onRemove: (profileID: LaunchProfileID) => void;
  readonly onDuplicate: (profile: LaunchProfile) => void;
}): ReactElement {
  const { draft, onChange, onRemove, onDuplicate } = props;
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

  const remove = useCallback(() => {
    onRemove(profile.id);
  }, [onRemove, profile.id]);

  const duplicate = useCallback(() => {
    onDuplicate(profileOf(draft));
  }, [draft, onDuplicate]);

  const isRenamable = canRenameProfile(profile);

  return (
    <Section title={profileTitle(profile)}>
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
        <Alert variant="destructive">
          <AlertDescription>
            {draft.argumentDrafts[0]?.value ?? ""} is not on your PATH, so this profile is hidden
            from the picker. Give it an absolute path, or install it.
          </AlertDescription>
        </Alert>
      )}

      <Violations violations={violations} />

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={duplicate}>
          Duplicate
        </Button>
        {canRemoveProfile(profile) ? (
          <Button type="button" variant="destructive" onClick={remove} className="ml-auto">
            {props.isStored ? "Delete" : "Discard"}
          </Button>
        ) : undefined}
      </div>
    </Section>
  );
}

function IconChoice(props: {
  readonly iconName: string;
  readonly onChange: (iconName: string) => void;
}): ReactElement {
  return (
    <Section title="Icon">
      <RadioGroup
        value={props.iconName}
        onValueChange={props.onChange}
        className="grid grid-cols-4 gap-2"
      >
        {PROFILE_ICON_NAMES.map((iconName) => (
          <IconOption key={iconName} iconName={iconName} />
        ))}
      </RadioGroup>
    </Section>
  );
}

function IconOption(props: { readonly iconName: string }): ReactElement {
  const { iconName } = props;
  const id = useId();
  const captionID = `${id}-caption`;

  return (
    <FieldLabel
      htmlFor={id}
      className="has-data-checked:border-primary flex w-full flex-col items-center gap-1 rounded-lg border p-2"
    >
      <RadioGroupItem value={iconName} id={id} aria-labelledby={captionID} />
      <ProfileIcon iconName={iconName} />
      <span id={captionID} className="text-muted-foreground text-xs">
        {iconName}
      </span>
    </FieldLabel>
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
      <div>
        <Button type="button" variant="outline" size="sm" onClick={append}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          Add Variable
        </Button>
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

  const removeLabel = draft.key.trim().length === 0 ? "Remove variable" : `Remove ${draft.key}`;

  return (
    <div className="flex items-end gap-2">
      <TextField label="Name" value={draft.key} onChange={changeKey} isMonospaced />
      <TextField label="Value" value={draft.value} onChange={changeValue} isMonospaced />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={remove}
        aria-label={removeLabel}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
