import type { Session, TerminalID, TerminalState } from "@janela/core";
import { FieldDescription } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import {
  type BackgroundServiceControlling,
  type GlobalSettings,
  isConfirmationSilenced,
  withSilencedConfirmation,
} from "../../../shared/model/index.ts";
import {
  CLOSING_CONFIRMATION_SECTION,
  DAEMON_SECTION,
  NOTIFICATION_PERMISSION_SECTION,
} from "../model/settings-index.ts";
import { SettingsDaemon } from "./daemon-settings.tsx";
import { SwitchField } from "./fields.tsx";
import { PaneGroup, Section } from "./pane.tsx";

export interface SettingsPermissionsProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
}

export function SettingsPermissions(props: SettingsPermissionsProps): ReactElement {
  const { settings, onChange } = props;

  const changeAsksBeforeClosing = useCallback(
    (asks: boolean) => {
      onChange(withSilencedConfirmation(settings, "closeTerminals", !asks));
    },
    [onChange, settings],
  );

  return (
    <>
      <Section section={CLOSING_CONFIRMATION_SECTION}>
        <SwitchField
          label="Ask before closing a running terminal"
          isOn={!isConfirmationSilenced(settings, "closeTerminals")}
          onChange={changeAsksBeforeClosing}
          hint="Idle and finished terminals never ask. Turning this off is the same as ticking Don't ask again in the dialog."
        />
      </Section>

      <Section section={NOTIFICATION_PERMISSION_SECTION}>
        <FieldDescription>
          macOS asks for permission the first time a notification would actually be sent, not at
          launch. Declining is fine — the sidebar keeps working, and Janela never asks again on its
          own. Change your answer under System Settings › Notifications.
        </FieldDescription>
      </Section>

      <PaneGroup section={DAEMON_SECTION}>
        <SettingsDaemon
          sessions={props.sessions}
          terminalStates={props.terminalStates}
          service={props.service}
        />
      </PaneGroup>
    </>
  );
}
