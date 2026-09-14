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
  profileTitle,
  profileViolations,
  variablesAppending,
} from "./profile-editing.ts";
import { PROFILE_ICON_NAMES, ProfileIcon } from "./profile-icons.tsx";
import type { SettingsDraft } from "./settings-draft.ts";
import { draftProfiles, withDraftProfile, withoutDraftProfile } from "./settings-draft.ts";

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

/**
 * The list row is a button, not a `div` with a click handler: selecting a profile
 * is an action, and `Item`'s `render` is how the primitive lends its layout to
 * whichever element the semantics call for. Hoisted because the linter — rightly —
 * refuses JSX built during render as a prop.
 *
 * It is an empty template, not a control: `Item` renders it with the row's
 * children — the profile's name and its badges — which is where its label comes
 * from.
 */
// oxlint-disable-next-line jsx-a11y/control-has-associated-label -- see above
const PROFILE_ROW = <button type="button" />;

export interface SettingsProfilesProps {
  /** The mirror's profiles. The draft is read against them, never in place of them. */
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly draft: SettingsDraft;
  readonly onChangeDraft: (draft: SettingsDraft) => void;
}

/**
 * ## Why this pane takes the draft rather than a value and a callback
 *
 * It is the one pane whose edits are not a field: adding, duplicating and
 * deleting a profile are changes to a *list*, and the difference between
 * deleting a stored profile and discarding one that only ever existed in this
 * draft decides whether the daemon hears about it at all. Passing the draft down
 * keeps that decision next to the button that causes it, rather than in a flag
 * threaded back up.
 *
 * The open editor still holds a working copy, because argv and environment rows
 * need identities that survive a neighbour being removed. Every change writes
 * through to the draft on the way, so the list, the picker and the bar all see
 * the edit; the copy exists for the caret, not for the value.
 */
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
    // Staged on the spot rather than on a Save of its own: the row has to appear
    // in the list to be edited, and an unsaved row the bar does not count is one
    // the user loses by pressing Revert without being told.
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
        // Dimmed rather than hidden: this is the surface where a missing binary
        // gets fixed, so the row has to stay reachable.
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

/**
 * The editor for one profile.
 *
 * It has no Save of its own: the bar at the bottom of the screen commits this
 * form along with every other tab's, so a second Save here would be two
 * different promises about the same keystrokes. Delete and Duplicate stay,
 * because neither is a field — one stages a removal and the other stages a new
 * profile, and both are counted by the bar like any other change.
 *
 * Exported so it can be rendered — and tested — without first driving a click
 * through the list above it.
 */
export function ProfileEditor(props: {
  readonly draft: ProfileDraft;
  readonly isAvailable: boolean;
  /**
   * Whether the daemon has this profile. False for a new one or an unsaved
   * duplicate, which is discarded outright rather than deleted — and says so.
   */
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
          // Pushed away from the other one: a destructive action beside a button
          // people reach for is a mis-click waiting to happen.
          <Button type="button" variant="destructive" onClick={remove} className="ml-auto">
            {props.isStored ? "Delete" : "Discard"}
          </Button>
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
 * `role="radio"` would have to reimplement, and would get subtly wrong. Base UI's
 * `RadioGroup` mirrors a hidden `input[type=radio]` per option and keeps that
 * behaviour.
 */
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
    // `htmlFor` reaches the hidden radio Base UI mirrors, so the whole card is a
    // click target; `aria-labelledby` names the visible radio with the icon's
    // name, which is the only text that distinguishes one option from another.
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

  // A freshly added row has no name yet, and an icon-only button whose label is
  // `Remove ` is a button a screen reader cannot announce.
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
