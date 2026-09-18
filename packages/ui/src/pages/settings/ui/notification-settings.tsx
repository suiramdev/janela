import type { AttentionEvent, AttentionEventPreference, NotificationSound } from "@janela/client";
import { ATTENTION_EVENTS, SILENT_NOTIFICATION_SOUND } from "@janela/client";
import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@janela/design";
import { Match } from "effect";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useId } from "react";

import { SYSTEM_NOTIFICATION_SOUNDS } from "../../../shared/config/index.ts";
import type { GlobalSettings, NotificationSoundControlling } from "../../../shared/model/index.ts";
import { withNotificationEvent } from "../../../shared/model/index.ts";
import { NOTIFICATIONS_EVENTS_SECTION } from "../model/settings-index.ts";
import { Section } from "./pane.tsx";

export interface SettingsNotificationsProps {
  readonly settings: GlobalSettings;
  readonly onChange: (settings: GlobalSettings) => void;
  readonly sound: NotificationSoundControlling | undefined;
}

const SILENT_VALUE = "silent";

const CUSTOM_VALUE = "custom";

const CHOOSE_VALUE = "choose";

const SYSTEM_PREFIX = "system:";

export const CHOOSE_SOUND_LABEL = "Choose a file…";

const EVENT_LABEL = {
  bell: "A terminal rings the bell",
  waiting: "An agent is waiting for you",
  finished: "An agent finishes",
  failed: "An agent stops with an error",
} satisfies Record<AttentionEvent, string>;

const EVENT_HINT = {
  bell: "Off by default: a bell badges the sidebar either way. A program that asks macOS for a notification by name always delivers, and takes this sound.",
  waiting: "An agent asking permission or a question is the thing you most want to hear about.",
  finished: "The agent ended its turn and nothing went wrong.",
  failed:
    "Also a command that failed after more than ten seconds, which always delivers and takes this sound.",
} satisfies Record<AttentionEvent, string>;

export function SettingsNotifications(props: SettingsNotificationsProps): ReactElement {
  const { settings, onChange } = props;

  const change = useCallback(
    (event: AttentionEvent, preference: AttentionEventPreference) => {
      onChange(withNotificationEvent(settings, event, preference));
    },
    [onChange, settings],
  );

  return (
    <Section section={NOTIFICATIONS_EVENTS_SECTION}>
      {ATTENTION_EVENTS.map((event) => (
        <NotificationEventField
          key={event}
          event={event}
          preference={settings.notifications[event]}
          control={props.sound}
          onChange={change}
        />
      ))}
    </Section>
  );
}

function NotificationEventField(props: {
  readonly event: AttentionEvent;
  readonly preference: AttentionEventPreference;
  readonly control: NotificationSoundControlling | undefined;
  readonly onChange: (event: AttentionEvent, preference: AttentionEventPreference) => void;
}): ReactElement {
  const { event, preference, control, onChange } = props;
  const id = useId();
  const labelID = `${id}-label`;

  const toggle = useCallback(
    (notifies: boolean) => {
      onChange(event, { ...preference, notifies });
    },
    [event, onChange, preference],
  );

  const choose = useCallback(
    (sound: NotificationSound) => {
      onChange(event, { ...preference, sound });
    },
    [event, onChange, preference],
  );

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel id={labelID} htmlFor={id}>
          {EVENT_LABEL[event]}
        </FieldLabel>
        <FieldDescription>{EVENT_HINT[event]}</FieldDescription>
      </FieldContent>
      <div className="flex shrink-0 items-center gap-2">
        {control === undefined ? undefined : (
          <NotificationSoundPicker
            label={EVENT_LABEL[event]}
            sound={preference.sound}
            isEnabled={preference.notifies}
            control={control}
            onChange={choose}
          />
        )}
        <Switch
          id={id}
          aria-labelledby={labelID}
          checked={preference.notifies}
          onCheckedChange={toggle}
        />
      </div>
    </Field>
  );
}

function NotificationSoundPicker(props: {
  readonly label: string;
  readonly sound: NotificationSound;
  readonly isEnabled: boolean;
  readonly control: NotificationSoundControlling;
  readonly onChange: (sound: NotificationSound) => void;
}): ReactElement {
  const { sound, control, onChange } = props;

  const select = useCallback(
    (changed: ChangeEvent<HTMLSelectElement>) => {
      const value = changed.target.value;

      if (value === CHOOSE_VALUE) {
        void control.chooseFile().then((path) => {
          if (path === undefined) return undefined;

          const chosen: NotificationSound = { kind: "custom", path };

          onChange(chosen);

          return control.play(chosen);
        });

        return;
      }

      if (value === SILENT_VALUE) {
        onChange(SILENT_NOTIFICATION_SOUND);

        return;
      }

      const chosen: NotificationSound = { kind: "system", name: value.slice(SYSTEM_PREFIX.length) };

      onChange(chosen);
      void control.play(chosen);
    },
    [control, onChange],
  );

  const preview = useCallback(() => {
    void control.play(sound);
  }, [control, sound]);

  const value = Match.value(sound).pipe(
    Match.when({ kind: "silent" }, () => SILENT_VALUE),
    Match.when({ kind: "system" }, (system) => `${SYSTEM_PREFIX}${system.name}`),
    Match.when({ kind: "custom" }, () => CUSTOM_VALUE),
    Match.exhaustive,
  );

  const fileName =
    sound.kind === "custom" ? (sound.path.split("/").at(-1) ?? sound.path) : undefined;

  return (
    <>
      <NativeSelect
        aria-label={`Sound — ${props.label}`}
        value={value}
        disabled={!props.isEnabled}
        onChange={select}
      >
        <NativeSelectOption value={SILENT_VALUE}>Silent</NativeSelectOption>
        {SYSTEM_NOTIFICATION_SOUNDS.map((name) => (
          <NativeSelectOption key={name} value={`${SYSTEM_PREFIX}${name}`}>
            {name}
          </NativeSelectOption>
        ))}
        {fileName === undefined ? undefined : (
          <NativeSelectOption value={CUSTOM_VALUE}>{fileName}</NativeSelectOption>
        )}
        <NativeSelectOption value={CHOOSE_VALUE}>{CHOOSE_SOUND_LABEL}</NativeSelectOption>
      </NativeSelect>
      <Button
        variant="outline"
        type="button"
        aria-label={`Play — ${props.label}`}
        onClick={preview}
        disabled={!props.isEnabled || sound.kind === "silent"}
      >
        Play
      </Button>
    </>
  );
}
