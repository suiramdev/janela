import type { ReactElement } from "react";
import { useCallback } from "react";

import type { GlobalSettings } from "../../../shared/model/index.ts";
import {
  NOTIFICATIONS_AGENTS_SECTION,
  NOTIFICATIONS_BELL_SECTION,
} from "../model/settings-index.ts";
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

  const changeNotifiesWhenAgentFinishes = useCallback(
    (notifiesWhenAgentFinishes: boolean) => {
      onChange({ ...settings, notifiesWhenAgentFinishes });
    },
    [onChange, settings],
  );

  const changeNotifiesWhenAgentWaits = useCallback(
    (notifiesWhenAgentWaits: boolean) => {
      onChange({ ...settings, notifiesWhenAgentWaits });
    },
    [onChange, settings],
  );

  return (
    <>
      <Section section={NOTIFICATIONS_BELL_SECTION}>
        <SwitchField
          label="Notify when a terminal rings the bell"
          isOn={settings.notifiesOnBell}
          onChange={changeNotifiesOnBell}
          hint="Off by default: a bell badges the sidebar; turn this on and it also notifies. Programs that ask for a notification by name always deliver."
        />
      </Section>

      <Section section={NOTIFICATIONS_AGENTS_SECTION}>
        <SwitchField
          label="Notify when an agent finishes"
          isOn={settings.notifiesWhenAgentFinishes}
          onChange={changeNotifiesWhenAgentFinishes}
          hint="On by default. The sidebar shows a finished agent whatever you choose; this decides whether Janela also interrupts you."
        />
        <SwitchField
          label="Notify when an agent is waiting for you"
          isOn={settings.notifiesWhenAgentWaits}
          onChange={changeNotifiesWhenAgentWaits}
          hint="On by default. An agent that asks permission or a question is the thing you most want to hear about."
        />
      </Section>
    </>
  );
}
