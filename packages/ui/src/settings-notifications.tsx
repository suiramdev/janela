import type { ReactElement } from "react";
import { useCallback } from "react";

import { Section, SwitchField } from "./controls.tsx";
import type { GlobalSettings } from "./global-settings.ts";
import * as style from "./styles.ts";

/**
 * The Notifications tab: one switch.
 *
 * ## Why only one
 *
 * The rules that matter are not configurable, because they are the ones the user
 * would get wrong. "Not the terminal you are looking at" and "only when Janela is
 * not frontmost" are facts, not preferences, and a notification policy the user
 * has mis-tuned trains them to distrust the badge — which costs more than every
 * switch we could offer. So the settings surface is one switch per class of
 * signal, not a predicate builder (ADR 0011 § Alternatives).
 *
 * The one genuine choice is the bell, because a bell means whatever the program
 * ringing it decided: a finished build, a failed test, or a `printf` in a loop.
 * An explicit OSC 9 or OSC 777 is not a choice — the program asked for a
 * notification by name, and that is consent.
 *
 * ## What this switch does not do
 *
 * In-app state is unaffected by anything on this pane. The pane indicator and the
 * sidebar badge update on every signal regardless, because the sidebar is the
 * primary channel and needs no permission — including from a user who denied
 * notifications years ago.
 */

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
    <div style={style.PANE}>
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
      <p style={style.HINT}>
        Permission is asked for the first time a notification would actually be sent, not at launch.
        Declining is fine — the sidebar keeps working.
      </p>
    </div>
  );
}
