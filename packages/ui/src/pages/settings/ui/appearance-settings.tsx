import { TERMINAL_FONT_STACK } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type GlobalSettings,
  TERMINAL_FONT_SIZE_BOUNDS,
  withTerminalFontFamily,
  withTerminalFontSize,
} from "../../../shared/model/index.ts";
import { APPEARANCE_FONT_SECTION } from "../model/settings-index.ts";
import { NumberField, TextField } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsAppearanceProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
}

export function SettingsAppearance(props: SettingsAppearanceProps): ReactElement {
  const { settings, onChange } = props;

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
  );
}
