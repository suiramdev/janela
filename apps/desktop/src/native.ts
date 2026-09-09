import { absolutePath, type AbsolutePath } from "@janela/core";
import type { NativeShell } from "@janela/ui";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

/**
 * The desktop's half of `NativeShell`.
 *
 * **The app performs file selection; the daemon is handed paths.** That is a rule,
 * not a convenience: it keeps macOS permission prompts attributed to the app the
 * user just clicked rather than to a background binary they have never heard of
 * (docs/decisions/0017-daemon-lifecycle.md § TCC attribution).
 */
export function tauriNativeShell(): NativeShell {
  return {
    async pickDirectory(options): Promise<AbsolutePath | undefined> {
      const chosen = await open({ directory: true, multiple: false, title: options.title });
      // `null` is a cancelled dialog, which is an answer rather than a failure.
      return chosen === null ? undefined : absolutePath(chosen);
    },

    async confirm(options): Promise<boolean> {
      return await ask(options.message, {
        title: options.title,
        kind: "warning",
        okLabel: options.confirmLabel,
        cancelLabel: "Cancel",
      });
    },

    async revealInFinder(path): Promise<void> {
      await revealItemInDir(path);
    },

    async openInTerminal(path): Promise<void> {
      // Terminal.app by name, which the capability scopes to exactly that: opening
      // a directory with the user's *default* handler would be Finder again.
      await openPath(path, "Terminal");
    },
  };
}
