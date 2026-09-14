import type { ClientRequest } from "@janela/client";
import type {
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  ProjectSettings,
} from "@janela/core";

import { automationViolations } from "./automation-editing.ts";
import type { GlobalSettings } from "./global-settings.ts";
import type { ProfileDraft } from "./profile-editing.ts";
import { profileOf, profileViolations } from "./profile-editing.ts";
import type { SettingsRoute } from "./view-state.ts";

/**
 * Everything the settings screen has changed and not yet saved.
 *
 * ## Why every tab has a draft
 *
 * The panes used to apply as you type, which is right for a preference and wrong
 * for the things this screen actually edits. An automation command and a launch
 * profile are *programs*: applied per keystroke, `pnpm ins` is a real command
 * until the next character arrives, and a half-typed executable is what ⌘T
 * offers in the meantime. Once one surface needs a Save button, the rest need one
 * too — a screen where some switches commit instantly and others wait is a screen
 * where the user cannot tell which did what.
 *
 * So there is one draft, for the whole screen, and one bar that commits it. Two
 * consequences follow, and both are deliberate:
 *
 * - **Switching tabs keeps your edits.** The draft outlives the pane; it lives in
 *   `ViewState`, so leaving settings entirely and coming back does too. Nothing
 *   the user typed is discarded by navigation, only by Revert.
 * - **Saving writes every tab's changes**, not the one you are looking at. That
 *   is what one bar means, and it is why the bar says how many there are.
 *
 * ## What is *not* in here
 *
 * Actions. Stopping the background service, and the two-press confirmation in
 * front of it, are not settings — they happen when pressed, and a draft would
 * put the user's terminals in a state they have to remember to confirm.
 *
 * ## The shape: edits, not a copy
 *
 * A field holds the mirror's value *or* the user's, never a full snapshot of
 * everything. An untouched project keeps flowing from the daemon while another
 * one is being edited, and saving sends exactly what was touched — a whole-copy
 * draft would write back a stale value for every row the user never looked at.
 */

/** One project's settings, mid-edit. The id travels with them to the daemon. */
export interface ProjectSettingsEdit {
  readonly projectID: ProjectID;
  readonly settings: ProjectSettings;
}

export interface SettingsDraft {
  /** Global settings as a whole: they are stored and saved as one value. */
  readonly settings: GlobalSettings | undefined;
  /** Profiles edited or newly added. A draft, not a value: argv rows need ids. */
  readonly profiles: readonly ProfileDraft[];
  readonly removedProfileIDs: readonly LaunchProfileID[];
  readonly projects: readonly ProjectSettingsEdit[];
}

export const EMPTY_SETTINGS_DRAFT: SettingsDraft = {
  settings: undefined,
  profiles: [],
  removedProfileIDs: [],
  projects: [],
};

/** The global settings the panes should show: the user's edit, or the stored value. */
export function draftSettings(draft: SettingsDraft, stored: GlobalSettings): GlobalSettings {
  return draft.settings ?? stored;
}

export function withDraftSettings(draft: SettingsDraft, settings: GlobalSettings): SettingsDraft {
  return { ...draft, settings };
}

/**
 * The profile list the panes should show: the mirror's, with staged edits applied,
 * staged removals gone, and staged additions at the end.
 *
 * Additions go last rather than in name order because the row the user just
 * created should be where they can find it, and the list is otherwise the
 * daemon's own order.
 */
export function draftProfiles(
  draft: SettingsDraft,
  stored: readonly LaunchProfile[],
): readonly LaunchProfile[] {
  const kept = stored
    .filter((profile) => !draft.removedProfileIDs.includes(profile.id))
    .map((profile) => {
      const edit = draft.profiles.find((entry) => entry.profile.id === profile.id);
      return edit === undefined ? profile : profileOf(edit);
    });
  const added = draft.profiles
    .filter((entry) => !stored.some((profile) => profile.id === entry.profile.id))
    .map(profileOf);
  return [...kept, ...added];
}

export function withDraftProfile(draft: SettingsDraft, edited: ProfileDraft): SettingsDraft {
  const known = draft.profiles.some((entry) => entry.profile.id === edited.profile.id);
  return {
    ...draft,
    profiles: known
      ? draft.profiles.map((entry) => (entry.profile.id === edited.profile.id ? edited : entry))
      : [...draft.profiles, edited],
  };
}

/**
 * Stages a profile's deletion — or drops it outright when the daemon never had
 * it.
 *
 * The distinction is why `stored` is a parameter: deleting a profile that only
 * ever existed in this draft is a discard, and sending `removeLaunchProfile` for
 * an id the daemon has never seen would be asking it to forget nothing.
 */
export function withoutDraftProfile(
  draft: SettingsDraft,
  profileID: LaunchProfileID,
  stored: readonly LaunchProfile[],
): SettingsDraft {
  const withoutEdit = draft.profiles.filter((entry) => entry.profile.id !== profileID);
  if (!stored.some((profile) => profile.id === profileID)) {
    return { ...draft, profiles: withoutEdit };
  }
  return {
    ...draft,
    profiles: withoutEdit,
    removedProfileIDs: draft.removedProfileIDs.includes(profileID)
      ? draft.removedProfileIDs
      : [...draft.removedProfileIDs, profileID],
  };
}

/** This project's settings as the pane should show them: the edit, or the mirror's. */
export function draftProjectSettings(draft: SettingsDraft, project: Project): ProjectSettings {
  const edit = draft.projects.find((candidate) => candidate.projectID === project.id);
  return edit?.settings ?? project.settings;
}

export function withDraftProjectSettings(
  draft: SettingsDraft,
  projectID: ProjectID,
  settings: ProjectSettings,
): SettingsDraft {
  const known = draft.projects.some((edit) => edit.projectID === projectID);
  return {
    ...draft,
    projects: known
      ? draft.projects.map((edit) =>
          edit.projectID === projectID ? { projectID, settings } : edit,
        )
      : [...draft.projects, { projectID, settings }],
  };
}

/**
 * Why the draft cannot be saved yet, and where the problem is.
 *
 * The route matters because the bar is shared: with one Save for every tab, a
 * blank executable typed into a project's automation would otherwise disable a
 * button on the Terminal pane with no way to find out why. Only *staged* values
 * are checked — an invalid command the user has not touched is not something
 * this save would write.
 */
export interface DraftViolation {
  readonly route: SettingsRoute;
  readonly message: string;
}

const PROFILES_ROUTE: SettingsRoute = { kind: "tab", tab: "profiles" };

export function draftViolations(draft: SettingsDraft): readonly DraftViolation[] {
  const profiles = draft.profiles.flatMap((entry) =>
    profileViolations(profileOf(entry)).map((message) => ({ route: PROFILES_ROUTE, message })),
  );
  const projects = draft.projects.flatMap((edit) =>
    edit.settings.automation.flatMap((command) =>
      automationViolations(command).map((message) => ({
        route: { kind: "project", projectID: edit.projectID } as const,
        message,
      })),
    ),
  );
  return [...profiles, ...projects];
}

/**
 * The messages a save sends, in the order it sends them.
 *
 * Pure, and separate from the screen, for one reason: this is the only place
 * where "the user pressed Save" turns into writes the daemon acts on, and a
 * mapping that can only be exercised by clicking a button is a mapping nothing
 * checks. Global settings are not here — they are the client's own store and
 * never cross the socket; `draftSettingsToSave` is their counterpart.
 *
 * `since` is the draft as last saved, and everything identical to it is left
 * out. A save does not clear the draft — the values stay on screen, because
 * dropping them would show the mirror's older answer until the daemon's
 * broadcast landed — so without this a second Save would re-send the first
 * one's writes, including a `removeLaunchProfile` for a profile that is already
 * gone. Compared by reference, for the same reason the bar is: every edit is an
 * immutable update, so an entry that is still the same object is one nothing has
 * touched since it was written.
 *
 * Order is deliberate. Profiles are written before the projects that may name
 * one as their default, so a project never points at a profile the daemon has
 * not seen; removals come after saves so that an edit and a deletion of the same
 * profile in one draft cannot resurrect it.
 */
export function settingsDraftRequests(
  draft: SettingsDraft,
  since: SettingsDraft,
): readonly ClientRequest[] {
  return [
    ...draft.profiles
      .filter((entry) => !since.profiles.includes(entry))
      .map((entry) => ({ type: "saveLaunchProfile", profile: profileOf(entry) }) as const),
    ...draft.removedProfileIDs
      .filter((profileID) => !since.removedProfileIDs.includes(profileID))
      .map((profileID) => ({ type: "removeLaunchProfile", profileID }) as const),
    ...draft.projects
      .filter((edit) => !since.projects.includes(edit))
      .map(
        (edit) =>
          ({
            type: "updateProjectSettings",
            projectID: edit.projectID,
            settings: edit.settings,
          }) as const,
      ),
  ];
}

/** The global settings a save writes, absent when they are not what changed. */
export function draftSettingsToSave(
  draft: SettingsDraft,
  since: SettingsDraft,
): GlobalSettings | undefined {
  if (draft.settings === undefined || draft.settings === since.settings) return undefined;
  return draft.settings;
}

/**
 * How many things Save would write.
 *
 * Shown in the bar, because one bar committing every tab has to say how far its
 * reach goes: "2 unsaved changes" while looking at a pane with one edit on it is
 * the difference between a Save the user understands and one they gamble on.
 *
 * Counted against `since` — the draft as last saved — for exactly the reason
 * `settingsDraftRequests` filters against it: a save leaves its values in the
 * draft, so counting the whole thing would promise to write edits that have
 * already been written. The number and the messages have to be the same answer,
 * or the sentence is a lie about the button beside it.
 */
export function draftEditCount(draft: SettingsDraft, since: SettingsDraft): number {
  return (
    (draftSettingsToSave(draft, since) === undefined ? 0 : 1) +
    settingsDraftRequests(draft, since).length
  );
}
