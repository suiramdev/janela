import type { Session, TerminalID, TerminalState } from "@janela/core";
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
  NOTIFICATION_PERMISSION_SECTION,
} from "../model/settings-index.ts";
import { SettingsDaemon } from "./daemon-settings.tsx";
import { SwitchRow } from "./fields.tsx";
import { SettingRow, SettingsGroup } from "./pane.tsx";

export interface SettingsPermissionsProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly service: BackgroundServiceControlling | undefined;
}

export const CLOSING_HINT = "Idle and finished terminals never ask.";

export const NOTIFICATION_PERMISSION_HINT =
  "macOS asks the first time Janela notifies. Change it in System Settings › Notifications.";

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
      <SettingsGroup section={CLOSING_CONFIRMATION_SECTION}>
        <SwitchRow
          label="Ask before closing a running terminal"
          description={CLOSING_HINT}
          isOn={!isConfirmationSilenced(settings, "closeTerminals")}
          onChange={changeAsksBeforeClosing}
        />
      </SettingsGroup>

      <SettingsGroup section={NOTIFICATION_PERMISSION_SECTION}>
        <SettingRow label="Notifications" description={NOTIFICATION_PERMISSION_HINT} />
      </SettingsGroup>

      <SettingsDaemon
        sessions={props.sessions}
        terminalStates={props.terminalStates}
        service={props.service}
      />
    </>
  );
}
