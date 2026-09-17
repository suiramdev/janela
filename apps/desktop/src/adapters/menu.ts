import { log } from "@janela/support";
import { COMMANDS, isCommandID, type CommandID, type CommandSource } from "@janela/ui";
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
