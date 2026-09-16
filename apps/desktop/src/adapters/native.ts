import { absolutePath, type AbsolutePath } from "@janela/core";
import type { NativeShell } from "@janela/ui";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

export function tauriNativeShell(): NativeShell {
  return {
    async pickDirectory(options): Promise<AbsolutePath | undefined> {
      const chosen = await open({ directory: true, multiple: false, title: options.title });

      return chosen === null ? undefined : absolutePath(chosen);
    },

    async revealInFinder(path): Promise<void> {
      await revealItemInDir(path);
    },

    async openInTerminal(path): Promise<void> {
      await openPath(path, "Terminal");
    },
  };
}
