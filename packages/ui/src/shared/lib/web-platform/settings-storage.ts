import { identifier } from "@janela/core";
import { Effect, Option, Result, Schema } from "effect";

import { isCommandID, parseAccelerator } from "../../config/index.ts";
import {
  CONFIRMATION_KEYS,
  DEFAULT_GLOBAL_SETTINGS,
  withCommandShortcut,
  withTerminalFontSize,
  type GlobalSettings,
  type SettingsStoring,
} from "../../model/index.ts";

const KEY = "janela.settings";

const absent = (): Effect.Effect<Option.Option<never>> => Effect.succeed(Option.none());

const StoredSettings = Schema.Struct({
  terminalFontFamily: Schema.optionalKey(Schema.String).pipe(Schema.catchDecoding(absent)),
  terminalFontSize: Schema.optionalKey(Schema.Number).pipe(Schema.catchDecoding(absent)),
  notifiesOnBell: Schema.optionalKey(Schema.Boolean).pipe(Schema.catchDecoding(absent)),
  defaultProfileID: Schema.optionalKey(Schema.String.check(Schema.isUUID())).pipe(
    Schema.catchDecoding(absent),
  ),
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

  if (fields.notifiesOnBell !== undefined) {
    settings = { ...settings, notifiesOnBell: fields.notifiesOnBell };
  }

  if (fields.terminalFontFamily !== undefined && fields.terminalFontFamily.length > 0) {
    settings = { ...settings, terminalFontFamily: fields.terminalFontFamily };
  }

  if (fields.defaultProfileID !== undefined) {
    settings = {
      ...settings,
      defaultProfileID: identifier<"LaunchProfile">(fields.defaultProfileID),
    };
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
