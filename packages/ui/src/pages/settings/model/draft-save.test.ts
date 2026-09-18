import { describe, expect, test } from "bun:test";

import { fakeProject, fakeSettings } from "../../../shared/lib/test-fakes/index.ts";
import {
  DEFAULT_GLOBAL_SETTINGS,
  EMPTY_SETTINGS_DRAFT,
  draftProjectSettings,
  withDraftProjectSettings,
  withDraftSettings,
  withTerminalFontSize,
} from "../../../shared/model/index.ts";
import {
  draftEditCount,
  draftSettingsToSave,
  draftViolations,
  settingsDraftRequests,
} from "./draft-save.ts";

const PROJECT = fakeProject();

const OTHER = fakeProject({ name: "api" });

const HANGING_TEARDOWN = { sessionTeardown: { script: "docker compose down", timeoutSeconds: 0 } };

const DEV_SCRIPT = { sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } };

describe("what blocks a save", () => {
  test("nothing, for a draft that has not broken anything", () => {
    expect(draftViolations(EMPTY_SETTINGS_DRAFT)).toEqual([]);
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
      withDraftProjectSettings(
        withDraftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS),
        PROJECT.id,
        fakeSettings(),
      ),
      OTHER.id,
      fakeSettings({ automation: DEV_SCRIPT }),
    );

    expect(draftEditCount(draft, EMPTY_SETTINGS_DRAFT)).toBe(3);
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

  test("one message per project edited, in the order they were edited", () => {
    const settings = fakeSettings({ automation: DEV_SCRIPT });

    const draft = withDraftProjectSettings(
      withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, settings),
      OTHER.id,
      fakeSettings(),
    );

    expect(settingsDraftRequests(draft, NOTHING_SAVED)).toEqual([
      { type: "updateProjectSettings", projectID: PROJECT.id, settings },
      { type: "updateProjectSettings", projectID: OTHER.id, settings: fakeSettings() },
    ]);
  });

  test("only what has changed since the last save", () => {
    const first = withDraftProjectSettings(
      withDraftSettings(EMPTY_SETTINGS_DRAFT, DEFAULT_GLOBAL_SETTINGS),
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
      fakeSettings({ automation: DEV_SCRIPT }),
    );

    expect(settingsDraftRequests(again, saved)).toEqual([
      {
        type: "updateProjectSettings",
        projectID: PROJECT.id,
        settings: fakeSettings({ automation: DEV_SCRIPT }),
      },
    ]);
  });
});
