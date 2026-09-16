import { NO_WINDOW_CONTROLS, type WindowControls } from "@janela/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface WindowControlsDeps {
  readonly isMacOS?: boolean | undefined;
}

export function tauriWindowControls(deps: WindowControlsDeps = {}): WindowControls {
  const isMacOS = deps.isMacOS ?? navigator.userAgent.includes("Mac OS X");

  if (!isMacOS) return NO_WINDOW_CONTROLS;

  const listeners = new Set<() => void>();
  const appWindow = getCurrentWindow();
  let areVisible = true;
  let isAsking = false;

  const ask = (): void => {
    if (isAsking) return;

    isAsking = true;
    void appWindow.isFullscreen().then(
      (isFullscreen) => {
        isAsking = false;

        if (isFullscreen !== !areVisible) {
          areVisible = !isFullscreen;

          for (const listener of listeners) listener();
        }

        return undefined;
      },
      () => {
        isAsking = false;

        return undefined;
      },
    );
  };

  ask();
  void appWindow.onResized(ask);

  return {
    get areVisible(): boolean {
      return areVisible;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
