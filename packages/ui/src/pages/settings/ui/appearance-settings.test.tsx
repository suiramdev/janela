import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "../../../shared/model/index.ts";
import { SettingsAppearance } from "./appearance-settings.tsx";

const noop = (): void => {};

const BROWSER_HINT = "In a browser the theme is the browser";

const radios = (markup: string): string[] => markup.match(/<span[^>]*role="radio"[^>]*>/g) ?? [];

function paneMarkup(settings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS, canApply = true): string {
  return renderToStaticMarkup(
    <SettingsAppearance settings={settings} canApplyTheme={canApply} onChange={noop} />,
  );
}

describe("the appearance pane", () => {
  test("offers the three themes in order and checks the held one", () => {
    const markup = paneMarkup({ ...DEFAULT_GLOBAL_SETTINGS, theme: "light" });
    const checked = radios(markup).map((radio) => radio.includes('aria-checked="true"'));

    expect(checked).toEqual([false, true, false]);
    expect(markup.indexOf(">System<")).toBeLessThan(markup.indexOf(">Light<"));
    expect(markup.indexOf(">Light<")).toBeLessThan(markup.indexOf(">Dark<"));
    expect(markup).not.toContain(BROWSER_HINT);
  });

  test("in a browser the choice is shown, disabled, and says why", () => {
    const markup = paneMarkup(DEFAULT_GLOBAL_SETTINGS, false);

    expect(radios(markup)).toHaveLength(3);
    expect(radios(markup).every((radio) => radio.includes('aria-disabled="true"'))).toBe(true);
    expect(markup).toContain(BROWSER_HINT);
  });
});
