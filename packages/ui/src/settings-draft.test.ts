import { describe, expect, test } from "bun:test";

import { newAutomationID } from "@janela/core";

import { DEFAULT_GLOBAL_SETTINGS, withTerminalFontSize } from "./global-settings.ts";
import { profileDraft, profileOf } from "./profile-editing.ts";
import {
  draftEditCount,
  draftProfiles,
  draftProjectSettings,
  draftSettings,
  draftSettingsToSave,
  draftViolations,
  EMPTY_SETTINGS_DRAFT,
  settingsDraftRequests,
  withDraftProfile,
  withDraftProjectSettings,
  withDraftSettings,
  withoutDraftProfile,
} from "./settings-draft.ts";
import { fakeProfile, fakeProject, fakeSettings, fakeShellProfile } from "./test-fakes.ts";

const SHELL = fakeShellProfile();
const CLAUDE = fakeProfile({ name: "Claude Code" });
const STORED = [SHELL, CLAUDE];

const PROJECT = fakeProject();
const OTHER = fakeProject({ name: "api" });

const command = (argv: readonly string[], isEnabled = true) => ({
  id: newAutomationID(),
  event: "sessionStart" as const,
  command: argv,
  isEnabled,
  timeoutSeconds: 30,
});

describe("global settings", () => {
  test("read as the stored value until they are edited", () => {
    expect(draftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS)).toBe(
      DEFAULT_GLOBAL_SETTINGS,
    );
  });

  test("read as the edit once there is one, whatever the store says", () => {
    const edited = withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 20);
    const draft = withDraftSettings(EMPTY_SETTINGS_DRAFT, edited);

    expect(draftSettings(draft, DEFAULT_GLOBAL_SETTINGS).terminalFontSize).toBe(20);
  });
});

describe("the profile list", () => {
  test("is the mirror's until the draft touches it", () => {
    expect(draftProfiles(EMPTY_SETTINGS_DRAFT, STORED)).toEqual(STORED);
  });

  test("shows an edited profile's new name before it is saved", () => {
    const renamed = profileDraft({ ...CLAUDE, name: "Claude" });
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, renamed);

    expect(draftProfiles(draft, STORED).map((profile) => profile.name)).toEqual([
      "Shell",
      "Claude",
    ]);
  });

  test("puts a new profile at the end, where the user just created it", () => {
    const added = profileDraft(fakeProfile({ name: "Codex" }));
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, added);

    expect(draftProfiles(draft, STORED).map((profile) => profile.name)).toEqual([
      "Shell",
      "Claude Code",
      "Codex",
    ]);
  });

  test("hides a profile staged for deletion", () => {
    const draft = withoutDraftProfile(EMPTY_SETTINGS_DRAFT, CLAUDE.id, STORED);

    expect(draftProfiles(draft, STORED).map((profile) => profile.name)).toEqual(["Shell"]);
    expect(draft.removedProfileIDs).toEqual([CLAUDE.id]);
  });

  test("deleting a profile the daemon never had asks it to forget nothing", () => {
    // A profile added and then removed inside one draft is a discard: sending
    // `removeLaunchProfile` for an id it has never seen is a lie about state.
    const added = profileDraft(fakeProfile({ name: "Codex" }));
    const staged = withDraftProfile(EMPTY_SETTINGS_DRAFT, added);
    const draft = withoutDraftProfile(staged, added.profile.id, STORED);

    expect(draft.removedProfileIDs).toEqual([]);
    expect(draft.profiles).toEqual([]);
    expect(draftProfiles(draft, STORED)).toEqual(STORED);
  });

  test("editing the same profile twice replaces the edit rather than queueing two", () => {
    const once = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...CLAUDE, name: "a" }));
    const twice = withDraftProfile(once, profileDraft({ ...CLAUDE, name: "b" }));

    expect(twice.profiles).toHaveLength(1);
    expect(twice.profiles.map((entry) => profileOf(entry).name)).toEqual(["b"]);
  });

  test("a deletion drops the pending edit for the same profile", () => {
    // Otherwise a save would write the profile and then remove it.
    const edited = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...CLAUDE, name: "a" }));
    const draft = withoutDraftProfile(edited, CLAUDE.id, STORED);

    expect(draft.profiles).toEqual([]);
    expect(draft.removedProfileIDs).toEqual([CLAUDE.id]);
  });
});

describe("a project's settings", () => {
  test("are the mirror's until the draft touches them", () => {
    expect(draftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT)).toBe(PROJECT.settings);
  });

  test("are per project: editing one leaves the other reading the mirror", () => {
    // The reason the draft holds edits rather than a copy of everything.
    const draft = withDraftProjectSettings(
      EMPTY_SETTINGS_DRAFT,
      PROJECT.id,
      fakeSettings({ isForgeEnabled: false }),
    );

    expect(draftProjectSettings(draft, PROJECT).isForgeEnabled).toBe(false);
    expect(draftProjectSettings(draft, OTHER)).toBe(OTHER.settings);
  });

  test("keep one edit per project however many keystrokes it took", () => {
    const once = withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, fakeSettings());
    const twice = withDraftProjectSettings(
      once,
      PROJECT.id,
      fakeSettings({ isForgeEnabled: false }),
    );

    expect(twice.projects).toHaveLength(1);
    expect(draftProjectSettings(twice, PROJECT).isForgeEnabled).toBe(false);
  });
});

describe("what blocks a save", () => {
  test("nothing, for a draft that has not broken anything", () => {
    expect(draftViolations(EMPTY_SETTINGS_DRAFT)).toEqual([]);
  });

  test("a staged profile with no name, named with the pane to fix it on", () => {
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...CLAUDE, name: " " }));

    expect(draftViolations(draft)).toEqual([
      { route: { kind: "tab", tab: "profiles" }, message: "A profile needs a name." },
    ]);
  });

  test("a staged automation command with no executable, named with its project", () => {
    // The route is the point: one Save for every tab means the thing blocking it
    // is frequently not on the pane the user is looking at.
    const draft = withDraftProjectSettings(
      EMPTY_SETTINGS_DRAFT,
      PROJECT.id,
      fakeSettings({ automation: [command([""])] }),
    );

    expect(draftViolations(draft)).toEqual([
      {
        route: { kind: "project", projectID: PROJECT.id },
        message: "An enabled command needs an executable.",
      },
    ]);
  });

  test("not a project's stored commands, which this save would not write", () => {
    const broken = fakeProject({ settings: fakeSettings({ automation: [command([""])] }) });

    expect(draftViolations(EMPTY_SETTINGS_DRAFT)).toEqual([]);
    expect(draftProjectSettings(EMPTY_SETTINGS_DRAFT, broken).automation).toHaveLength(1);
  });
});

describe("the change count", () => {
  test("is zero for an untouched draft", () => {
    expect(draftEditCount(EMPTY_SETTINGS_DRAFT, EMPTY_SETTINGS_DRAFT)).toBe(0);
  });

  test("counts global settings once however many fields were changed", () => {
    // They are stored and saved as one value, so they are one change.
    const once = withDraftSettings(
      EMPTY_SETTINGS_DRAFT,
      withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 20),
    );
    const twice = withDraftSettings(once, withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, 21));

    expect(draftEditCount(twice, EMPTY_SETTINGS_DRAFT)).toBe(1);
  });

  test("counts every tab's edits, which is what one Save writes", () => {
    const draft = withDraftProjectSettings(
      withoutDraftProfile(
        withDraftProfile(
          withDraftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS),
          profileDraft(fakeProfile({ name: "Codex" })),
        ),
        CLAUDE.id,
        STORED,
      ),
      PROJECT.id,
      fakeSettings(),
    );

    expect(draftEditCount(draft, EMPTY_SETTINGS_DRAFT)).toBe(4);
  });

  test("stops counting an edit once it has been saved", () => {
    // The bar's sentence and the messages Save sends have to be the same
    // answer: the draft keeps its values after a save, so a second edit reads
    // as one change, not as two.
    const saved = withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, fakeSettings());
    const again = withDraftProjectSettings(saved, OTHER.id, fakeSettings());

    expect(draftEditCount(saved, saved)).toBe(0);
    expect(draftEditCount(again, saved)).toBe(1);
    expect(draftEditCount(again, saved)).toBe(settingsDraftRequests(again, saved).length);
  });
});

describe("what a save writes", () => {
  const NOTHING_SAVED = EMPTY_SETTINGS_DRAFT;

  test("nothing at all for an untouched draft", () => {
    expect(settingsDraftRequests(EMPTY_SETTINGS_DRAFT, NOTHING_SAVED)).toEqual([]);
    expect(draftSettingsToSave(EMPTY_SETTINGS_DRAFT, NOTHING_SAVED)).toBeUndefined();
  });

  test("not the global settings, which never cross the socket", () => {
    // They are the client's own store, written by `SettingsStoring`.
    const draft = withDraftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS);
    expect(settingsDraftRequests(draft, NOTHING_SAVED)).toEqual([]);
    expect(draftSettingsToSave(draft, NOTHING_SAVED)).toBe(DEFAULT_GLOBAL_SETTINGS);
  });

  test("one message per edit, profiles before the projects that may name them", () => {
    // A project's default profile is a profile id: written the other way round,
    // the daemon would be asked to store a project pointing at a profile it has
    // never seen.
    const added = profileDraft(fakeProfile({ name: "Codex" }));
    const settings = fakeSettings({ defaultProfileID: added.profile.id });
    const draft = withDraftProjectSettings(
      withoutDraftProfile(withDraftProfile(EMPTY_SETTINGS_DRAFT, added), CLAUDE.id, STORED),
      PROJECT.id,
      settings,
    );

    expect(settingsDraftRequests(draft, NOTHING_SAVED)).toEqual([
      { type: "saveLaunchProfile", profile: profileOf(added) },
      { type: "removeLaunchProfile", profileID: CLAUDE.id },
      { type: "updateProjectSettings", projectID: PROJECT.id, settings },
    ]);
  });

  test("a profile edited and then deleted is removed, not written back", () => {
    const edited = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...CLAUDE, name: "a" }));
    const draft = withoutDraftProfile(edited, CLAUDE.id, STORED);

    expect(settingsDraftRequests(draft, NOTHING_SAVED)).toEqual([
      { type: "removeLaunchProfile", profileID: CLAUDE.id },
    ]);
  });

  test("only what has changed since the last save", () => {
    // The draft keeps its values after a save so the screen does not flicker
    // back to the mirror. Writing it whole again would re-send the first save's
    // messages — including a deletion of a profile that is already gone.
    const added = profileDraft(fakeProfile({ name: "Codex" }));
    const first = withDraftProjectSettings(
      withoutDraftProfile(
        withDraftSettings(withDraftProfile(EMPTY_SETTINGS_DRAFT, added), DEFAULT_GLOBAL_SETTINGS),
        CLAUDE.id,
        STORED,
      ),
      PROJECT.id,
      fakeSettings(),
    );
    // One new edit, of a kind the first save already wrote: the other project's.
    const second = withDraftProjectSettings(first, OTHER.id, fakeSettings());

    expect(settingsDraftRequests(second, first)).toEqual([
      { type: "updateProjectSettings", projectID: OTHER.id, settings: fakeSettings() },
    ]);
    expect(draftSettingsToSave(second, first)).toBeUndefined();
  });

  test("an edit made after a save is written by the next one", () => {
    const saved = withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, fakeSettings());
    const again = withDraftProjectSettings(
      saved,
      PROJECT.id,
      fakeSettings({ isForgeEnabled: false }),
    );

    expect(settingsDraftRequests(again, saved)).toEqual([
      {
        type: "updateProjectSettings",
        projectID: PROJECT.id,
        settings: fakeSettings({ isForgeEnabled: false }),
      },
    ]);
  });
});
