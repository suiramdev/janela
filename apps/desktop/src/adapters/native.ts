import { absolutePath, isWebURL, type AbsolutePath } from "@janela/core";
import type { DirectoryPicking, ExternalLinks, NativeShell } from "@janela/ui";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export interface DirectoryDialogOptions {
  readonly directory: true;
  readonly multiple: false;
  readonly title: string;
}

export type DirectoryDialog = (options: DirectoryDialogOptions) => Promise<string | null>;

export type PathOpener = (path: string, openWith: string) => Promise<void>;

export type ItemRevealer = (path: string) => Promise<void>;

export type URLOpener = (url: string) => Promise<void>;

interface DirectoryPickerDeps {
  readonly open?: DirectoryDialog | undefined;
}

interface ExternalLinksDeps {
  readonly openUrl?: URLOpener | undefined;
}

interface NativeShellDeps {
  readonly openPath?: PathOpener | undefined;
  readonly revealItemInDir?: ItemRevealer | undefined;
}

export const TERMINAL_APP = "Terminal";

export function tauriDirectoryPicker(deps: DirectoryPickerDeps = {}): DirectoryPicking {
  const openDialog = deps.open ?? open;

  return {
    async pickDirectory(request): Promise<AbsolutePath | undefined> {
      const chosen = await openDialog({ directory: true, multiple: false, title: request.title });

      return chosen === null ? undefined : absolutePath(chosen);
    },
  };
}

export function tauriNativeShell(deps: NativeShellDeps = {}): NativeShell {
  const openWith = deps.openPath ?? openPath;
  const reveal = deps.revealItemInDir ?? revealItemInDir;

  return {
    async revealInFinder(path): Promise<void> {
      await reveal(path);
    },

    async openInTerminal(path): Promise<void> {
      await openWith(path, TERMINAL_APP);
    },
  };
}

export function tauriLinks(deps: ExternalLinksDeps = {}): ExternalLinks {
  const openInBrowser: URLOpener = deps.openUrl ?? openUrl;

  return {
    async open(url): Promise<void> {
      if (isWebURL(url)) await openInBrowser(url);
    },
  };
}
