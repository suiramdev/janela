import type { NotificationSound } from "@janela/client";
import { absolutePath, type AbsolutePath } from "@janela/core";
import { log, type Logger } from "@janela/support";
import type { NotificationSoundControlling } from "@janela/ui";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Effect, Result } from "effect";

export interface SoundDialogOptions {
  readonly multiple: false;
  readonly directory: false;
  readonly title: string;
  readonly filters: readonly { readonly name: string; readonly extensions: string[] }[];
}

export type SoundDialog = (options: SoundDialogOptions) => Promise<string | null>;

export type SoundInvoke = typeof invoke;

export interface NotificationSoundDeps {
  readonly invoke?: SoundInvoke | undefined;
  readonly open?: SoundDialog | undefined;
  readonly log?: Logger | undefined;
}

export const PLAY_COMMAND = "play_notification_sound";

export const SOUND_DIALOG_TITLE = "Choose Notification Sound";

export const SOUND_EXTENSIONS = ["aiff", "aif", "wav", "caf", "m4a", "mp3", "aac", "flac"];

export function tauriNotificationSound(
  deps: NotificationSoundDeps = {},
): NotificationSoundControlling {
  const invokeFn = deps.invoke ?? invoke;
  const openDialog = deps.open ?? open;
  const logger = deps.log ?? log("app");

  return {
    async play(sound: NotificationSound): Promise<void> {
      if (sound.kind === "silent") return;

      const played = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            try: () => invokeFn<void>(PLAY_COMMAND, { sound }),
            catch: (cause) => cause,
          }),
        ),
      );

      if (Result.isFailure(played)) {
        logger.warning("notification sound unavailable", { sound: sound.kind });
      }
    },

    async chooseFile(): Promise<AbsolutePath | undefined> {
      const chosen = await openDialog({
        multiple: false,
        directory: false,
        title: SOUND_DIALOG_TITLE,
        filters: [{ name: "Sound", extensions: SOUND_EXTENSIONS }],
      });

      return chosen === null ? undefined : absolutePath(chosen);
    },
  };
}
