import type { AbsolutePath } from "@janela/core";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";

import {
  type AppearanceControl,
  type Clipboard,
  type CommandSource,
  type ConfirmationKey,
  type ConfirmationQueue,
  type ConfirmationRequest,
  DEFAULT_GLOBAL_SETTINGS,
  type DirectoryPicking,
  type GlobalSettings,
  type NativeShell,
  type SettingsStoring,
  type ThemePreference,
  type WindowControls,
} from "../../model/index.ts";

export interface RecordingService {
  readonly calls: string[];
  stop(): void;
  stopAndUnregister(): void;
}

export interface RecordingConfirmations extends ConfirmationQueue {
  readonly asked: ConfirmationRequest[];
  readonly titles: readonly string[];
}

export interface RecordingNativeShell extends NativeShell {
  readonly calls: string[];
}

export interface RecordingDirectoryPicker extends DirectoryPicking {
  readonly calls: string[];
}

export interface RecordingClipboard extends Clipboard {
  readonly calls: string[];
  readonly text: string | undefined;
}

export interface RecordingSettingsStore extends SettingsStoring {
  readonly saved: GlobalSettings[];
}

export interface RecordingAppearance extends AppearanceControl {
  readonly applied: ThemePreference[];
}

export interface RecordingSurfaceHandle extends TerminalSurfaceHandle {
  readonly calls: string[];
}

export const overlaidWindowControls: WindowControls = {
  areVisible: true,
  subscribe: () => () => {},
};

export function recordingService(): RecordingService {
  const calls: string[] = [];

  return {
    calls,
    stop() {
      calls.push("stop");
    },
    stopAndUnregister() {
      calls.push("stopAndUnregister");
    },
  };
}

export function inertNativeShell(): RecordingNativeShell {
  const calls: string[] = [];

  return {
    calls,
    revealInFinder(path) {
      calls.push(`revealInFinder:${path}`);

      return Promise.resolve();
    },
    openInTerminal(path) {
      calls.push(`openInTerminal:${path}`);

      return Promise.resolve();
    },
  };
}

export function recordingDirectoryPicker(
  picks: AbsolutePath | undefined = undefined,
): RecordingDirectoryPicker {
  const calls: string[] = [];

  return {
    calls,
    pickDirectory(request) {
      calls.push(`pickDirectory:${request.title}`);

      return Promise.resolve(picks);
    },
  };
}

export function recordingConfirmations(behaviour: {
  readonly agrees: boolean;
  readonly silenced: readonly ConfirmationKey[] | undefined;
}): RecordingConfirmations {
  const asked: ConfirmationRequest[] = [];
  const silenced = behaviour.silenced ?? [];

  return {
    asked,
    get titles(): readonly string[] {
      return asked.map((request) => request.title);
    },
    pending: undefined,
    confirm(request) {
      if (request.remember !== undefined && silenced.includes(request.remember))
        return Promise.resolve(true);

      asked.push(request);

      return Promise.resolve(behaviour.agrees);
    },
    answer() {},
    subscribe() {
      return () => undefined;
    },
  };
}

export function recordingClipboard(initial: string | undefined): RecordingClipboard {
  let held = initial;
  const calls: string[] = [];

  return {
    calls,
    get text(): string | undefined {
      return held;
    },
    copy(text) {
      calls.push(`copy:${text}`);
      held = text;

      return Promise.resolve();
    },
    paste() {
      calls.push("paste");

      return Promise.resolve(held);
    },
  };
}

export function inertClipboard(): Clipboard {
  return {
    copy: () => Promise.resolve(),
    paste: () => Promise.resolve(undefined),
  };
}

export function neverCommands(): CommandSource {
  return { subscribe: () => () => {} };
}

export function memorySettingsStore(initial = DEFAULT_GLOBAL_SETTINGS): RecordingSettingsStore {
  let stored = initial;
  const saved: GlobalSettings[] = [];

  return {
    saved,
    load: () => Promise.resolve(stored),
    save(settings) {
      stored = settings;
      saved.push(settings);

      return Promise.resolve();
    },
  };
}

export function recordingAppearance(): RecordingAppearance {
  const applied: ThemePreference[] = [];

  return {
    applied,
    apply(theme) {
      applied.push(theme);

      return Promise.resolve();
    },
  };
}

export function fakeSurfaceHandle(): RecordingSurfaceHandle {
  const calls: string[] = [];

  return {
    calls,
    feed: () => {},
    clearViewport() {
      calls.push("clearViewport");
    },
    selectedText: () => undefined,
    paste(text) {
      calls.push(`paste:${text}`);
    },
    focus() {
      calls.push("focus");
    },
    viewport: () => undefined,
  };
}
