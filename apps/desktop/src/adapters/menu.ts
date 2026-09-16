import { log } from "@janela/support";
import { COMMANDS, isCommandID, type CommandID, type CommandSource } from "@janela/ui";
import { listen } from "@tauri-apps/api/event";
import { Effect, Result } from "effect";

import type { BridgeInvoke } from "./transport.ts";

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

export function tauriCommandSource(): CommandSource {
  return {
    subscribe(listener: (id: CommandID) => void): () => void {
      let unlisten: (() => void) | undefined;
      let cancelled = false;

      void listen<string>(COMMAND_EVENT, (event) => {
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
