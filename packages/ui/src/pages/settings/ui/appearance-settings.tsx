import { TERMINAL_FONT_STACK } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type GlobalSettings,
  TERMINAL_FONT_SIZE_BOUNDS,
  THEME_TITLE,
  type ThemePreference,
  withTerminalFontFamily,
  withTerminalFontSize,
  withTheme,
} from "../../../shared/model/index.ts";
import { APPEARANCE_FONT_SECTION, APPEARANCE_THEME_SECTION } from "../model/settings-index.ts";
import { type Choice, NumberRow, SelectRow, TextRow } from "./fields.tsx";
import { SettingsGroup } from "./pane.tsx";

export interface SettingsAppearanceProps {
  readonly settings: GlobalSettings;
  readonly canApplyTheme: boolean;
  readonly onChange: (settings: GlobalSettings) => void;
}

export const THEME_CHOICES: readonly Choice<ThemePreference>[] = [
  { value: "system", title: THEME_TITLE.system },
  { value: "light", title: THEME_TITLE.light },
  { value: "dark", title: THEME_TITLE.dark },
];

export const THEME_BROWSER_HINT = "Your browser sets the theme here.";

export function SettingsAppearance(props: SettingsAppearanceProps): ReactElement {
  const { settings, canApplyTheme, onChange } = props;

  const changeTheme = useCallback(
    (theme: ThemePreference) => {
      onChange(withTheme(settings, theme));
    },
    [onChange, settings],
  );

  const changeFamily = useCallback(
    (family: string) => {
      onChange(withTerminalFontFamily(settings, family));
    },
    [onChange, settings],
  );

  const changeSize = useCallback(
    (size: number) => {
      onChange(withTerminalFontSize(settings, size));
    },
    [onChange, settings],
  );

  return (
    <>
      <SettingsGroup section={APPEARANCE_THEME_SECTION}>
        <SelectRow
          label="Theme"
          value={settings.theme}
          choices={THEME_CHOICES}
          onChange={changeTheme}
          isDisabled={!canApplyTheme}
          description={canApplyTheme ? undefined : THEME_BROWSER_HINT}
        />
      </SettingsGroup>
      <SettingsGroup section={APPEARANCE_FONT_SECTION}>
        <TextRow
          label="Font family"
          description="Empty uses the default, with Nerd Font symbols."
          value={settings.terminalFontFamily ?? ""}
          onChange={changeFamily}
          placeholder={TERMINAL_FONT_STACK}
          isMonospaced
        />
        <NumberRow
          label="Font size"
          value={settings.terminalFontSize}
          onChange={changeSize}
          minimum={TERMINAL_FONT_SIZE_BOUNDS.minimum}
          maximum={TERMINAL_FONT_SIZE_BOUNDS.maximum}
          unit="px"
        />
      </SettingsGroup>
    </>
  );
}
