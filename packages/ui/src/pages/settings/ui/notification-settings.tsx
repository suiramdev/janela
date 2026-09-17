import type { ReactElement } from "react";
import { useCallback } from "react";

import type { GlobalSettings } from "../../../shared/model/index.ts";
import { NOTIFICATIONS_BELL_SECTION } from "../model/settings-index.ts";
import { SwitchField } from "./fields.tsx";
import { Section } from "./pane.tsx";

export interface SettingsNotificationsProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
}

export function SettingsNotifications(props: SettingsNotificationsProps): ReactElement {
  const { settings, onChange } = props;

  const changeNotifiesOnBell = useCallback(
    (notifiesOnBell: boolean) => {
      onChange({ ...settings, notifiesOnBell });
    },
    [onChange, settings],
  );

  return (
    <Section section={NOTIFICATIONS_BELL_SECTION}>
      <SwitchField
        label="Notify when a terminal rings the bell"
        isOn={settings.notifiesOnBell}
        onChange={changeNotifiesOnBell}
        hint="Off by default: a bell badges the sidebar but does not interrupt. Programs that ask for a notification by name always deliver, whatever this is set to."
      />
    </Section>
  );
}
