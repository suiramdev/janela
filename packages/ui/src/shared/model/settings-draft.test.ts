import { describe, expect, test } from "bun:test";

import {
  fakeProfile,
  fakeProject,
  fakeSettings,
  fakeShellProfile,
} from "../lib/test-fakes/index.ts";
import { DEFAULT_GLOBAL_SETTINGS, withTerminalFontSize } from "./global-settings.ts";
import { profileDraft, profileOf } from "./profile-draft.ts";
import {
  EMPTY_SETTINGS_DRAFT,
  draftProfiles,
  draftProjectSettings,
  draftSettings,
  withDraftProfile,
  withDraftProjectSettings,
  withDraftSettings,
  withoutDraftProfile,
} from "./settings-draft.ts";

const SHELL = fakeShellProfile();

const CLAUDE = fakeProfile({ name: "Claude Code" });

const STORED = [SHELL, CLAUDE];

const PROJECT = fakeProject();

const OTHER = fakeProject({ name: "api" });

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
    const draft = withDraftProjectSettings(
      EMPTY_SETTINGS_DRAFT,
      PROJECT.id,
      fakeSettings({ defaultProfileID: CLAUDE.id }),
    );

    expect(draftProjectSettings(draft, PROJECT).defaultProfileID).toBe(CLAUDE.id);
    expect(draftProjectSettings(draft, OTHER)).toBe(OTHER.settings);
  });

  test("keep one edit per project however many keystrokes it took", () => {
    const once = withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, fakeSettings());

    const twice = withDraftProjectSettings(
      once,
      PROJECT.id,
      fakeSettings({ defaultProfileID: CLAUDE.id }),
    );

    expect(twice.projects).toHaveLength(1);
    expect(draftProjectSettings(twice, PROJECT).defaultProfileID).toBe(CLAUDE.id);
  });
});
