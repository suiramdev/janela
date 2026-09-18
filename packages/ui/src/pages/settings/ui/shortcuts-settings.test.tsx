import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_GLOBAL_SETTINGS,
  type GlobalSettings,
  withCommandShortcut,
} from "../../../shared/model/index.ts";
import { NO_SHORTCUT, SHORTCUT_MENU_TITLE, SettingsShortcuts } from "./shortcuts-settings.tsx";

const noop = (): void => {};

function paneMarkup(settings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS): string {
  return renderToStaticMarkup(
    <SettingsShortcuts settings={settings} onChange={noop} onRecording={noop} />,
  );
}

describe("the shortcuts pane", () => {
  test("lists every menu, and every command under its menu", () => {
    const markup = paneMarkup();

    for (const title of Object.values(SHORTCUT_MENU_TITLE)) expect(markup).toContain(title);

    expect(markup).toContain("Close Pane");
    expect(markup).toContain("Reveal in Finder");
  });

  test("draws a chord as one cap per key, and a command with none as None", () => {
    const markup = paneMarkup();

    expect(markup).toContain('<kbd data-slot="kbd"');
    expect(markup).toMatch(/<kbd[^>]*>⌘<\/kbd><kbd[^>]*>⇧<\/kbd><kbd[^>]*>\]<\/kbd>/);
    expect(markup).toContain(NO_SHORTCUT);
  });

  test("offers a reset only on a command the user has changed", () => {
    const changed = withCommandShortcut(DEFAULT_GLOBAL_SETTINGS, "splitRight", "CmdOrCtrl+E");

    expect(paneMarkup()).not.toContain("Reset ");
    expect(paneMarkup(changed)).toContain('aria-label="Reset Split Vertically to its default"');
    expect(paneMarkup(changed)).not.toContain('aria-label="Reset Close Pane to its default"');
    expect(paneMarkup(changed)).toMatch(/<kbd[^>]*>⌘<\/kbd><kbd[^>]*>E<\/kbd>/);
  });
});
