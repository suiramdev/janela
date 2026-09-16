import { TERMINAL_FONT_STACK } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type GlobalSettings,
  isConfirmationSilenced,
  TERMINAL_FONT_SIZE_BOUNDS,
  withSilencedConfirmation,
  withTerminalFontFamily,
  withTerminalFontSize,
} from "../../../shared/model/index.ts";
import { TERMINAL_CLOSING_SECTION, TERMINAL_FONT_SECTION } from "../model/settings-index.ts";
import { NumberField, SwitchField, TextField } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsTerminalProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
}

export function SettingsTerminal(props: SettingsTerminalProps): ReactElement {
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

  const changeAsksBeforeClosing = useCallback(
    (asks: boolean) => {
      onChange(withSilencedConfirmation(settings, "closeTerminals", !asks));
    },
    [onChange, settings],
  );

  return (
    <>
      <Section section={TERMINAL_FONT_SECTION}>
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

      <Section section={TERMINAL_CLOSING_SECTION}>
        <SwitchField
          label="Ask before closing a running terminal"
          isOn={!isConfirmationSilenced(settings, "closeTerminals")}
          onChange={changeAsksBeforeClosing}
          hint="Idle and finished terminals never ask. Turning this off is the same as ticking Don't ask again in the dialog."
        />
      </Section>
    </>
  );
}
