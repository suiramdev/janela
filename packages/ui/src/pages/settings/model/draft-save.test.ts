import { describe, expect, test } from "bun:test";

import {
  fakeProfile,
  fakeProject,
  fakeSettings,
  fakeShellProfile,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  DEFAULT_GLOBAL_SETTINGS,
  EMPTY_SETTINGS_DRAFT,
  draftProjectSettings,
  profileDraft,
  profileOf,
  withDraftProfile,
  withDraftProjectSettings,
  withDraftSettings,
  withTerminalFontSize,
  withoutDraftProfile,
} from "../../../shared/model/index.ts";
import {
  draftEditCount,
  draftSettingsToSave,
  draftViolations,
  settingsDraftRequests,
} from "./draft-save.ts";

const SHELL = fakeShellProfile();

const CLAUDE = fakeProfile({ name: "Claude Code" });

const STORED = [SHELL, CLAUDE];

const PROJECT = fakeProject();

const OTHER = fakeProject({ name: "api" });

const HANGING_TEARDOWN = { sessionTeardown: { script: "docker compose down", timeoutSeconds: 0 } };

describe("what blocks a save", () => {
  test("nothing, for a draft that has not broken anything", () => {
    expect(draftViolations(EMPTY_SETTINGS_DRAFT)).toEqual([]);
  });

  test("a staged profile with no name, named with the pane to fix it on", () => {
    const draft = withDraftProfile(EMPTY_SETTINGS_DRAFT, profileDraft({ ...CLAUDE, name: " " }));

    expect(draftViolations(draft)).toEqual([
      { route: { kind: "tab", tab: "integrations" }, message: "A profile needs a name." },
    ]);
  });

  test("a staged teardown that would never time out, named with its project", () => {
    const draft = withDraftProjectSettings(
      EMPTY_SETTINGS_DRAFT,
      PROJECT.id,
      fakeSettings({ automation: HANGING_TEARDOWN }),
    );

    expect(draftViolations(draft)).toEqual([
      {
        route: { kind: "project", projectID: PROJECT.id },
        message: "A teardown timeout must be at least one second.",
      },
    ]);
  });

  test("not a project's stored scripts, which this save would not write", () => {
    const broken = fakeProject({ settings: fakeSettings({ automation: HANGING_TEARDOWN }) });

    expect(draftViolations(EMPTY_SETTINGS_DRAFT)).toEqual([]);
    expect(draftProjectSettings(EMPTY_SETTINGS_DRAFT, broken).automation).toEqual(HANGING_TEARDOWN);
  });
});

describe("the change count", () => {
  test("is zero for an untouched draft", () => {
    expect(draftEditCount(EMPTY_SETTINGS_DRAFT, EMPTY_SETTINGS_DRAFT)).toBe(0);
  });

  test("counts global settings once however many fields were changed", () => {
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
    const draft = withDraftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS);

    expect(settingsDraftRequests(draft, NOTHING_SAVED)).toEqual([]);
    expect(draftSettingsToSave(draft, NOTHING_SAVED)).toBe(DEFAULT_GLOBAL_SETTINGS);
  });

  test("one message per edit, profiles before the projects that may name them", () => {
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
      fakeSettings({ defaultProfileID: CLAUDE.id }),
    );

    expect(settingsDraftRequests(again, saved)).toEqual([
      {
        type: "updateProjectSettings",
        projectID: PROJECT.id,
        settings: fakeSettings({ defaultProfileID: CLAUDE.id }),
      },
    ]);
  });
});
