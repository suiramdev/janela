import type { AbsolutePath } from "@janela/core";

export type NotificationSound =
  | { readonly kind: "silent" }
  | { readonly kind: "system"; readonly name: string }
  | { readonly kind: "custom"; readonly path: AbsolutePath };

export interface NotificationSoundPlaying {
  play(sound: NotificationSound): Promise<void>;
}

export const SILENT_NOTIFICATION_SOUND: NotificationSound = { kind: "silent" };
