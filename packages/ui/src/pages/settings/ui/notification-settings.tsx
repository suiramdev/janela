import { FieldDescription } from "@janela/design";
import type { ReactElement } from "react";
import { useCallback } from "react";

import type { GlobalSettings } from "../../../shared/model/index.ts";
import { Section, SwitchField } from "./fields.tsx";

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
    <div className="flex flex-col gap-6">
      <Section
        title="Notification Centre"
        hint="Janela never notifies for the terminal you are looking at, and never while its window is frontmost and that session is selected."
      >
        <SwitchField
          label="Notify when a terminal rings the bell"
          isOn={settings.notifiesOnBell}
          onChange={changeNotifiesOnBell}
          hint="Off by default: a bell badges the sidebar but does not interrupt. Programs that ask for a notification by name always deliver, whatever this is set to."
        />
      </Section>
      <FieldDescription>
        Permission is asked for the first time a notification would actually be sent, not at launch.
        Declining is fine — the sidebar keeps working.
      </FieldDescription>
    </div>
  );
}
