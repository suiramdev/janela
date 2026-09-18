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
import { type Choice, ChoiceField, NumberField, TextField } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsAppearanceProps {
  readonly settings: GlobalSettings;
  readonly canApplyTheme: boolean;
  readonly onChange: (settings: GlobalSettings) => void;
}

export const THEME_CHOICES: readonly Choice<ThemePreference>[] = [
  { value: "system", title: THEME_TITLE.system, detail: "Whatever macOS is showing right now." },
  { value: "light", title: THEME_TITLE.light, detail: "Light, whatever the time of day." },
  { value: "dark", title: THEME_TITLE.dark, detail: "Dark, whatever the time of day." },
];

export const THEME_BROWSER_HINT =
  "In a browser the theme is the browser's to set; Janela's own window is where this applies.";

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
      <Section section={APPEARANCE_THEME_SECTION}>
        <ChoiceField
          label="Theme"
          value={settings.theme}
          choices={THEME_CHOICES}
          onChange={changeTheme}
          isDisabled={!canApplyTheme}
          hint={canApplyTheme ? undefined : THEME_BROWSER_HINT}
        />
      </Section>
      <Section section={APPEARANCE_FONT_SECTION}>
        <TextField
          label="Font family"
          value={settings.terminalFontFamily ?? ""}
          onChange={changeFamily}
          placeholder={TERMINAL_FONT_STACK}
          isMonospaced
          hint="Leave it empty for the default stack, which draws icons from the Symbols Nerd Font Mono Janela ships. Name a Nerd Font here to draw text in one too. A font Janela cannot find falls back through the stack, so a typo degrades rather than breaks."
        />
        <NumberField
          label="Font size"
          value={settings.terminalFontSize}
          onChange={changeSize}
          minimum={TERMINAL_FONT_SIZE_BOUNDS.minimum}
          maximum={TERMINAL_FONT_SIZE_BOUNDS.maximum}
          hint="Changing this re-measures the cell, which resizes every attached terminal's grid."
        />
      </Section>
    </>
  );
}
