import { ATTENTION_EVENTS, type NotificationSound } from "@janela/client";
import { absolutePath } from "@janela/core";
import { Effect, Match, Option, Result, Schema } from "effect";

import { isCommandID, parseAccelerator, SYSTEM_NOTIFICATION_SOUNDS } from "../../config/index.ts";
import {
  CONFIRMATION_KEYS,
  DEFAULT_GLOBAL_SETTINGS,
  isThemePreference,
  withCommandShortcut,
  withNotificationEvent,
  withTerminalFontSize,
  withTheme,
  type GlobalSettings,
  type SettingsStoring,
} from "../../model/index.ts";

const KEY = "janela.settings";

const absent = (): Effect.Effect<Option.Option<never>> => Effect.succeed(Option.none());

const StoredNotificationSound = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("silent") }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    name: Schema.Literals(SYSTEM_NOTIFICATION_SOUNDS),
  }),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    path: Schema.String.check(Schema.isStartsWith("/")),
  }),
]);

type StoredNotificationSound = (typeof StoredNotificationSound)["Type"];

const StoredAttentionEvent = Schema.Struct({
  notifies: Schema.optionalKey(Schema.Boolean).pipe(Schema.catchDecoding(absent)),
  sound: Schema.optionalKey(StoredNotificationSound).pipe(Schema.catchDecoding(absent)),
});

const StoredNotifications = Schema.Struct({
  bell: Schema.optionalKey(StoredAttentionEvent).pipe(Schema.catchDecoding(absent)),
  waiting: Schema.optionalKey(StoredAttentionEvent).pipe(Schema.catchDecoding(absent)),
  finished: Schema.optionalKey(StoredAttentionEvent).pipe(Schema.catchDecoding(absent)),
  failed: Schema.optionalKey(StoredAttentionEvent).pipe(Schema.catchDecoding(absent)),
});

const StoredSettings = Schema.Struct({
  theme: Schema.optionalKey(Schema.String).pipe(Schema.catchDecoding(absent)),
  terminalFontFamily: Schema.optionalKey(Schema.String).pipe(Schema.catchDecoding(absent)),
  terminalFontSize: Schema.optionalKey(Schema.Number).pipe(Schema.catchDecoding(absent)),
  notifications: Schema.optionalKey(StoredNotifications).pipe(Schema.catchDecoding(absent)),
  silencedConfirmations: Schema.optionalKey(Schema.Array(Schema.String)).pipe(
    Schema.catchDecoding(absent),
  ),
  commandShortcuts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)).pipe(
    Schema.catchDecoding(absent),
  ),
});

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSettings));

const decodeChord = Schema.decodeUnknownOption(Schema.String);

const readStored = Option.liftThrowable((storage: Storage) => storage.getItem(KEY));

export function localStorageSettings(storage: Storage = localStorage): SettingsStoring {
  return {
    load(): Promise<GlobalSettings> {
      return Promise.resolve(parseSettings(Option.getOrNull(readStored(storage))));
    },

    save(settings: GlobalSettings): Promise<void> {
      Result.try(() => storage.setItem(KEY, JSON.stringify(settings)));

      return Promise.resolve();
    },
  };
}

export function parseSettings(raw: string | null): GlobalSettings {
  if (raw === null) return DEFAULT_GLOBAL_SETTINGS;

  const stored = decodeStored(raw);

  if (Option.isNone(stored)) return DEFAULT_GLOBAL_SETTINGS;

  const fields = stored.value;

  const silenced = CONFIRMATION_KEYS.filter(
    (key) => fields.silencedConfirmations?.includes(key) === true,
  );

  let settings: GlobalSettings = DEFAULT_GLOBAL_SETTINGS;

  if (fields.theme !== undefined && isThemePreference(fields.theme)) {
    settings = withTheme(settings, fields.theme);
  }

  for (const event of ATTENTION_EVENTS) {
    const entry = fields.notifications?.[event];

    if (entry === undefined) continue;

    const current = settings.notifications[event];

    settings = withNotificationEvent(settings, event, {
      notifies: entry.notifies ?? current.notifies,
      sound: entry.sound === undefined ? current.sound : storedSound(entry.sound),
    });
  }

  if (fields.terminalFontFamily !== undefined && fields.terminalFontFamily.length > 0) {
    settings = { ...settings, terminalFontFamily: fields.terminalFontFamily };
  }

  if (silenced.length > 0) settings = { ...settings, silencedConfirmations: silenced };

  for (const [id, chord] of Object.entries(fields.commandShortcuts ?? {})) {
    const accelerator = Option.getOrUndefined(decodeChord(chord));

    if (
      isCommandID(id) &&
      accelerator !== undefined &&
      parseAccelerator(accelerator) !== undefined
    ) {
      settings = withCommandShortcut(settings, id, accelerator);
    }
  }

  return fields.terminalFontSize === undefined
    ? settings
    : withTerminalFontSize(settings, fields.terminalFontSize);
}

function storedSound(stored: StoredNotificationSound): NotificationSound {
  return Match.value(stored).pipe(
    Match.when(
      { kind: "custom" },
      // SAFETY: the schema above accepted this string only because it starts with `/`, which is the whole of `absolutePath`'s precondition, so the call cannot throw.
      (custom): NotificationSound => ({ kind: "custom", path: absolutePath(custom.path) }),
    ),
    Match.orElse((simple): NotificationSound => simple),
  );
}
