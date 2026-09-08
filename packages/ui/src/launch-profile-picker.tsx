import type { LaunchProfile, LaunchProfileAvailability, LaunchProfileID } from "@janela/core";
import { availableProfiles, usesLoginShell } from "@janela/core";
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { ProfileIcon } from "./profile-icons.tsx";
import * as style from "./styles.ts";

/**
 * Choosing what to start in a new terminal — the ⌘T surface.
 *
 * ## What is not here
 *
 * Any notion of an "agent". `isAgent` is a label on a row and grants no ordering,
 * no section, no behaviour, because agents get no special behaviour: a profile is
 * a command Janela starts, and the moment the picker treats one differently we
 * have begun modelling somebody else's tool.
 *
 * ## Hidden, never broken
 *
 * A profile whose executable is not on the captured `PATH` does not appear. Not
 * greyed out, not with a warning — absent, because "Claude Code (not installed)"
 * is an advert for something the user did not ask us to sell. The settings surface
 * is where an unavailable profile is visible, because that is where it can be
 * fixed.
 */

/**
 * What ⌘T lands on.
 *
 * Project default, then global default, then the first pickable profile, then
 * nothing. Each fallback exists because the step above it can name a profile that
 * is not pickable: a project can default to a profile the user has since
 * uninstalled, and preselecting it would put the highlight on a row that is not
 * on screen — so ⌘T-Return would start nothing at all.
 *
 * Positional parameters rather than an options object, deliberately: with
 * `exactOptionalPropertyTypes`, building one from two possibly-absent ids needs
 * conditional spreads, and a conditional spread inside a `useCallback` defeats the
 * dependency analysis the lint gate runs. `| undefined` says the same thing and
 * stays analysable.
 */
export function preselectedProfileID(
  pickable: readonly LaunchProfile[],
  projectDefaultID: LaunchProfileID | undefined,
  globalDefaultID: LaunchProfileID | undefined,
): LaunchProfileID | undefined {
  const pickableID = (id: LaunchProfileID | undefined): LaunchProfileID | undefined =>
    pickable.some((profile) => profile.id === id) ? id : undefined;

  return pickableID(projectDefaultID) ?? pickableID(globalDefaultID) ?? pickable[0]?.id;
}

/**
 * Where the arrow keys go, wrapping at both ends.
 *
 * Wrapping because this is a menu, and a menu of four entries where Down stops
 * dead at the bottom makes the user aim. `current` not being in `pickable`
 * happens when availability arrives while the picker is open; starting from the
 * top is the honest answer, since the row the user was on has gone.
 */
export function movedSelection(
  pickable: readonly LaunchProfile[],
  current: LaunchProfileID | undefined,
  delta: -1 | 1,
): LaunchProfileID | undefined {
  if (pickable.length === 0) return undefined;
  const index = pickable.findIndex((profile) => profile.id === current);
  if (index < 0) return pickable[0]?.id;
  const moved = (index + delta + pickable.length) % pickable.length;
  return pickable[moved]?.id;
}

/** The subtitle under a profile's name: what it will actually run. */
export function profileSubtitle(profile: LaunchProfile): string {
  return usesLoginShell(profile) ? "Your login shell" : profile.command.join(" ");
}

export interface LaunchProfilePickerProps {
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly projectDefaultID?: LaunchProfileID;
  readonly globalDefaultID?: LaunchProfileID;
  readonly onPick: (profileID: LaunchProfileID) => void;
  readonly onCancel: () => void;
}

export function LaunchProfilePicker(props: LaunchProfilePickerProps): ReactElement {
  const { profiles, availability, projectDefaultID, globalDefaultID, onPick, onCancel } = props;
  // Memoised because it feeds `handleKeyDown`'s dependencies: an array rebuilt
  // every render would rebuild the handler every render, and it is also the prop
  // every row is compared on.
  const pickable = useMemo(
    () => availableProfiles(profiles, availability),
    [profiles, availability],
  );

  const [chosen, setChosen] = useState<LaunchProfileID | undefined>(undefined);
  // Derived rather than stored-and-corrected: when availability arrives late and
  // removes the highlighted row, the preselection rule answers again instead of an
  // effect racing the render.
  const selected =
    chosen !== undefined && pickable.some((profile) => profile.id === chosen)
      ? chosen
      : preselectedProfileID(pickable, projectDefaultID, globalDefaultID);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Only the four keys a list owes its user. Nothing with `Ctrl`: this popover
      // sits over a terminal, and `Ctrl-n` belongs to whatever is running in it.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setChosen(movedSelection(pickable, selected, 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setChosen(movedSelection(pickable, selected, -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (selected !== undefined) onPick(selected);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    },
    [onCancel, onPick, pickable, selected],
  );

  if (pickable.length === 0) {
    // Reachable only if the login-shell built-in has been deleted, which the
    // built-in rules forbid — so it is a real state, not a designed one.
    return (
      <div style={style.PICKER}>
        <p style={style.HINT}>No launch profiles are available.</p>
      </div>
    );
  }

  return (
    // The ARIA listbox pattern, not a `<select>`: the rows carry an icon and the
    // command they will run, which a native select cannot render. `aria-label` and
    // `aria-activedescendant` are what make it announce as a list with a current
    // row, and the container owns the arrow keys.
    <div
      style={style.PICKER}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the comment above
      role="listbox"
      aria-label="Launch profile"
      aria-activedescendant={selected}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {pickable.map((profile) => (
        <ProfileRow
          key={profile.id}
          profile={profile}
          isSelected={profile.id === selected}
          onPick={onPick}
          onHighlight={setChosen}
        />
      ))}
    </div>
  );
}

function ProfileRow(props: {
  readonly profile: LaunchProfile;
  readonly isSelected: boolean;
  readonly onPick: (profileID: LaunchProfileID) => void;
  readonly onHighlight: (profileID: LaunchProfileID) => void;
}): ReactElement {
  const { profile, onPick, onHighlight } = props;
  const pick = useCallback(() => {
    onPick(profile.id);
  }, [onPick, profile.id]);
  const highlight = useCallback(() => {
    onHighlight(profile.id);
  }, [onHighlight, profile.id]);

  return (
    // A `button` so activation, focus and the focus ring are the platform's, with
    // `role="option"` because it is a row of the listbox above. `<option>` cannot
    // hold an icon, and is not focusable.
    <button
      type="button"
      id={profile.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the comment above
      role="option"
      aria-selected={props.isSelected}
      onClick={pick}
      onMouseEnter={highlight}
      onFocus={highlight}
      style={props.isSelected ? style.LIST_ROW_SELECTED : style.LIST_ROW}
    >
      <ProfileIcon iconName={profile.iconName} />
      <span>{profile.name}</span>
      <span style={style.HINT}>{profileSubtitle(profile)}</span>
    </button>
  );
}

export interface ProfileSelectProps {
  readonly label: string;
  readonly profiles: readonly LaunchProfile[];
  readonly availability: LaunchProfileAvailability;
  readonly value: LaunchProfileID | undefined;
  readonly onChange: (profileID: LaunchProfileID | undefined) => void;
  /** What an unset value means here — it differs per scope, so the caller says. */
  readonly unsetTitle: string;
  readonly hint?: string;
}

/**
 * A dropdown for "which profile by default", used by both settings scopes.
 *
 * Lists available profiles only, for the same reason the picker does — plus the
 * currently selected one even if it has become unavailable, because a select that
 * silently drops the stored value shows the user a setting they never made.
 */
export function ProfileSelect(props: ProfileSelectProps): ReactElement {
  const { onChange, profiles, value } = props;
  const pickable = availableProfiles(profiles, props.availability);
  const stored = profiles.find((profile) => profile.id === value);
  const listed =
    stored === undefined || pickable.includes(stored) ? pickable : [stored, ...pickable];

  const handle = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      // Matched rather than re-branded: the option values are ids this component
      // rendered, so looking one up is both the validation and the conversion.
      onChange(profiles.find((profile) => profile.id === event.target.value)?.id);
    },
    [onChange, profiles],
  );

  return (
    <label style={style.FIELD}>
      <span style={style.FIELD_LABEL}>{props.label}</span>
      <select value={value ?? ""} onChange={handle} style={style.INPUT}>
        <option value="">{props.unsetTitle}</option>
        {listed.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      {props.hint === undefined ? undefined : <span style={style.HINT}>{props.hint}</span>}
    </label>
  );
}
