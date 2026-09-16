import { absolutePath, type AbsolutePath } from "@janela/core";
import type { DirectoryPicking, NativeShell } from "@janela/ui";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

export function tauriDirectoryPicker(): DirectoryPicking {
  return {
    async pickDirectory(request): Promise<AbsolutePath | undefined> {
      const chosen = await open({ directory: true, multiple: false, title: request.title });

      return chosen === null ? undefined : absolutePath(chosen);
    },
  };
}

export function tauriNativeShell(): NativeShell {
  return {
    async revealInFinder(path): Promise<void> {
      await revealItemInDir(path);
    },

    async openInTerminal(path): Promise<void> {
      await openPath(path, "Terminal");
    },
  };
}
