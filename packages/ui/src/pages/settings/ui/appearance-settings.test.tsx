import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "../../../shared/model/index.ts";
import { SettingsAppearance, THEME_BROWSER_HINT } from "./appearance-settings.tsx";

const noop = (): void => {};

const options = (markup: string): string[] => markup.match(/<option[^>]*>[^<]*<\/option>/g) ?? [];

function paneMarkup(settings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS, canApply = true): string {
  return renderToStaticMarkup(
    <SettingsAppearance settings={settings} canApplyTheme={canApply} onChange={noop} />,
  );
}

describe("the appearance pane", () => {
  test("offers the three themes in one dropdown, in order, with nothing to explain them", () => {
    const markup = paneMarkup({ ...DEFAULT_GLOBAL_SETTINGS, theme: "light" });
    const themes = options(markup);

    expect(themes.map((option) => option.replace(/<[^>]*>/g, ""))).toEqual([
      "System",
      "Light",
      "Dark",
    ]);

    expect(themes[1]).toContain('selected=""');
    expect(markup).not.toContain(THEME_BROWSER_HINT);
  });

  test("in a browser the dropdown is shown, disabled, and says why", () => {
    const markup = paneMarkup(DEFAULT_GLOBAL_SETTINGS, false);

    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).toContain(THEME_BROWSER_HINT);
  });
});
