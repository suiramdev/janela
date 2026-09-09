import { log } from "@janela/support";
import { COMMANDS, isCommandID, type CommandID, type CommandSource } from "@janela/ui";
import { listen } from "@tauri-apps/api/event";

import type { BridgeInvoke } from "./transport.ts";

/**
 * The event a chosen menu item arrives on.
 *
 * Paired with `COMMAND_EVENT` in `apps/desktop/src-tauri/src/main.rs`; the two
 * spellings must match, and there is deliberately no third place that knows this
 * string.
 */
export const COMMAND_EVENT = "janela://command";

/**
 * Hands the shell the command table so it can build the menu bar.
 *
 * Once, at startup. The shell reads ids, titles, accelerators and which menu each
 * row goes in — so adding a row to `COMMANDS` adds a menu item, with no Rust
 * change and no second list to keep in step.
 *
 * A failure is logged and nothing else: a menu that did not install is a degraded
 * app, not a broken one, and every command is still reachable from ⌘⇧P.
 */
export async function installNativeMenu(invoke: BridgeInvoke): Promise<void> {
  try {
    await invoke<void>("install_menu", { commands: COMMANDS });
  } catch (error) {
    log("app").warning("menu install failed", { error: errorName(error) });
  }
}

/** Chosen menu items, as command ids. */
export function tauriCommandSource(): CommandSource {
  return {
    subscribe(listener: (id: CommandID) => void): () => void {
      let unlisten: (() => void) | undefined;
      let cancelled = false;

      void listen<string>(COMMAND_EVENT, (event) => {
        // The shell emits whatever id the user picked, as a plain string. An id
        // this build does not know is a version skew between the menu and the
        // table, and dropping it is better than dispatching a guess.
        if (isCommandID(event.payload)) listener(event.payload);
      }).then(
        (release) => {
          if (cancelled) release();
          else unlisten = release;
          return undefined;
        },
        (error: unknown) => {
          log("app").warning("menu events unavailable", { error: errorName(error) });
        },
      );

      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}

/** The error's name, never its message: a message can carry a path. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
