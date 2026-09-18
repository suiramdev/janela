import { log } from "@janela/support";
import {
  COMMANDS,
  commandsWithShortcuts,
  isCommandID,
  type CommandID,
  type CommandSource,
  type GlobalSettings,
} from "@janela/ui";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { Effect, Result } from "effect";

import type { BridgeInvoke } from "./transport.ts";

export type CommandEventListener = (
  event: string,
  handler: EventCallback<string>,
) => Promise<UnlistenFn>;

interface CommandSourceDeps {
  readonly listen?: CommandEventListener | undefined;
}

export interface ShortcutSettingsSource {
  readonly settings: GlobalSettings;
  readonly isRecordingShortcut: boolean;
  subscribe(listener: () => void): () => void;
}

export interface MenuAccelerator {
  readonly id: CommandID;
  readonly accelerator: string | null;
}

export type MenuAcceleratorApplier = (accelerators: readonly MenuAccelerator[]) => Promise<void>;

export const COMMAND_EVENT = "janela://command";

export async function installNativeMenu(invoke: BridgeInvoke): Promise<void> {
  const installed = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: () => invoke<void>("install_menu", { commands: COMMANDS }),
        catch: (cause) => cause,
      }),
    ),
  );

  if (Result.isFailure(installed)) {
    log("app").warning("menu install failed", { error: errorName(installed.failure) });
  }
}

export function nativeMenuAccelerators(invoke: BridgeInvoke): MenuAcceleratorApplier {
  return (accelerators) => invoke<void>("set_menu_accelerators", { accelerators });
}

export function syncNativeShortcuts(
  apply: MenuAcceleratorApplier,
  view: ShortcutSettingsSource,
): () => void {
  let applied: GlobalSettings["commandShortcuts"];
  let isReleased = false;

  const send = (accelerators: readonly MenuAccelerator[]): void => {
    apply(accelerators).catch((cause: unknown) => {
      log("app").warning("menu accelerators not updated", { error: errorName(cause) });
    });
  };

  const push = (): void => {
    if (view.isRecordingShortcut) {
      if (isReleased) return;

      isReleased = true;
      send(COMMANDS.map((command) => ({ id: command.id, accelerator: null })));

      return;
    }

    const { commandShortcuts } = view.settings;

    if (!isReleased && commandShortcuts === applied) return;

    isReleased = false;
    applied = commandShortcuts;

    send(
      commandsWithShortcuts(view.settings, true).map((command) => ({
        id: command.id,
        accelerator: command.accelerator ?? null,
      })),
    );
  };

  push();

  return view.subscribe(push);
}

export function tauriCommandSource(deps: CommandSourceDeps = {}): CommandSource {
  const listenTo: CommandEventListener = deps.listen ?? listen;

  return {
    subscribe(listener: (id: CommandID) => void): () => void {
      let unlisten: (() => void) | undefined;
      let cancelled = false;

      void listenTo(COMMAND_EVENT, (event) => {
        if (isCommandID(event.payload)) listener(event.payload);
      }).then(
        (release) => {
          if (cancelled) release();
          else unlisten = release;

          return undefined;
        },
        (cause: unknown) => {
          log("app").warning("menu events unavailable", { error: errorName(cause) });
        },
      );

      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : "unknown";
}
