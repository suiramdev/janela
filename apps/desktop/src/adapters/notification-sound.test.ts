import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import type { LogRecord, Logger } from "@janela/support";
import type { NotificationSoundControlling } from "@janela/ui";
import type { InvokeArgs } from "@tauri-apps/api/core";

import {
  PLAY_COMMAND,
  SOUND_EXTENSIONS,
  tauriNotificationSound,
  type SoundDialogOptions,
  type SoundInvoke,
} from "./notification-sound.ts";

interface Invocation {
  readonly command: string;
  readonly args: InvokeArgs | undefined;
}

interface RecordingLogger {
  readonly log: Logger;
  text(): string;
}

interface SoundHarness {
  readonly adapter: NotificationSoundControlling;
  readonly calls: readonly Invocation[];
  readonly requests: readonly SoundDialogOptions[];
}

interface SoundOptions {
  readonly refuses?: boolean | undefined;
  readonly picks?: string | undefined;
  readonly log?: Logger | undefined;
}

const SECRET_PATH = "/Users/me/Music/PRIVATE-4f10a2.aiff";

function recordingLogger(): RecordingLogger {
  const lines: string[] = [];

  const at =
    (level: LogRecord["level"]) =>
    (message: string, fields: LogRecord["fields"] = undefined): void => {
      lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
    };

  return {
    log: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    text: () => lines.join("\n"),
  };
}

function sound(options: SoundOptions): SoundHarness {
  const calls: Invocation[] = [];
  const requests: SoundDialogOptions[] = [];

  const invoke: SoundInvoke = <Answer>(
    command: string,
    args: InvokeArgs | undefined = undefined,
  ): Promise<Answer> => {
    calls.push({ command, args });

    if (options.refuses === true) return Promise.reject(new Error("unreadable sound file"));

    return Promise.resolve(undefined as Answer);
  };

  const adapter = tauriNotificationSound({
    invoke,
    open: (dialog) => {
      requests.push(dialog);

      return Promise.resolve(options.picks ?? null);
    },
    log: options.log,
  });

  return { adapter, calls, requests };
}

describe("tauriNotificationSound", () => {
  test("silence asks the shell for nothing at all", async () => {
    const { adapter, calls } = sound({});

    await adapter.play({ kind: "silent" });

    expect(calls).toEqual([]);
  });

  test("a chosen sound crosses as the shell's own choice", async () => {
    const { adapter, calls } = sound({});

    await adapter.play({ kind: "system", name: "Submarine" });
    await adapter.play({ kind: "custom", path: absolutePath(SECRET_PATH) });

    expect(calls).toEqual([
      { command: PLAY_COMMAND, args: { sound: { kind: "system", name: "Submarine" } } },
      { command: PLAY_COMMAND, args: { sound: { kind: "custom", path: SECRET_PATH } } },
    ]);
  });

  test("a sound that will not play is logged by kind, never by path", async () => {
    const logger = recordingLogger();
    const { adapter } = sound({ refuses: true, log: logger.log });

    await adapter.play({ kind: "custom", path: absolutePath(SECRET_PATH) });

    expect(logger.text()).toContain("notification sound unavailable");
    expect(logger.text()).not.toContain(SECRET_PATH);
  });

  test("the file dialog offers audio files and asks for one file", async () => {
    const { adapter, requests } = sound({ picks: SECRET_PATH });

    expect(await adapter.chooseFile()).toBe(absolutePath(SECRET_PATH));
    expect(requests[0]?.filters[0]?.extensions).toEqual(SOUND_EXTENSIONS);
    expect(requests[0]?.directory).toBe(false);
    expect(requests[0]?.multiple).toBe(false);
  });

  test("a cancelled dialog is no choice, not a path", async () => {
    const { adapter } = sound({});

    expect(await adapter.chooseFile()).toBeUndefined();
  });
});
