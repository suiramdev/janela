import { describe, expect, test } from "bun:test";

import { fakeProject, fakeSettings } from "../lib/test-fakes/index.ts";
import { DEFAULT_GLOBAL_SETTINGS, withTerminalFontSize } from "./global-settings.ts";
import {
  EMPTY_SETTINGS_DRAFT,
  draftProjectSettings,
  draftSettings,
  withDraftProjectSettings,
  withDraftSettings,
} from "./settings-draft.ts";

const PROJECT = fakeProject();

const OTHER = fakeProject({ name: "api" });

const DEV_SCRIPT = { sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } };

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

describe("a project's settings", () => {
  test("are the mirror's until the draft touches them", () => {
    expect(draftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT)).toBe(PROJECT.settings);
  });

  test("are per project: editing one leaves the other reading the mirror", () => {
    const draft = withDraftProjectSettings(
      EMPTY_SETTINGS_DRAFT,
      PROJECT.id,
      fakeSettings({ automation: DEV_SCRIPT }),
    );

    expect(draftProjectSettings(draft, PROJECT).automation).toEqual(DEV_SCRIPT);
    expect(draftProjectSettings(draft, OTHER)).toBe(OTHER.settings);
  });

  test("keep one edit per project however many keystrokes it took", () => {
    const once = withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, PROJECT.id, fakeSettings());

    const twice = withDraftProjectSettings(
      once,
      PROJECT.id,
      fakeSettings({ automation: DEV_SCRIPT }),
    );

    expect(twice.projects).toHaveLength(1);
    expect(draftProjectSettings(twice, PROJECT).automation).toEqual(DEV_SCRIPT);
  });
});
