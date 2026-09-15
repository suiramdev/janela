import type { WindowControls } from "@janela/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * An overlay title bar this window does not have: no buttons to dodge, ever.
 *
 * Shared by both non-macOS answers, and a constant because there is nothing to
 * notify about — a window whose controls are not inside it never grows any.
 */
const NO_OVERLAID_CONTROLS: WindowControls = {
  areVisible: false,
  subscribe: () => () => {},
};

/**
 * Whether macOS is drawing the traffic lights over the window right now.
 *
 * The title bar is an overlay (`titleBarStyle: "Overlay"`), so the buttons sit
 * inside the window, on the sidebar's first row — except in fullscreen, where
 * the system takes them away and that row should have its leading space back.
 * Only the shell can answer that, which is why the client asks through a port.
 *
 * ## Anywhere else, the row is simply empty
 *
 * `titleBarStyle`, `hiddenTitle` and `trafficLightPosition` are all macOS-only
 * keys: on any other platform the window keeps its own decorations *above* the
 * WebView, nothing overlaps that row, and this answers `false` for the life of
 * the process — no room reserved, and no mark or title put back in its place.
 * That is the intent and not a gap. The app's name is in the window's own title
 * bar there, and a sidebar that repeats it is the duplication this change
 * removed; a client that needs identity in the sidebar needs a reason first
 * (AGENTS.md § Non-negotiables 2 — the budget is four nouns, not a logo).
 *
 * ## Why a resize event and not a fullscreen one
 *
 * There is no fullscreen event. tao reports a resize on the way into fullscreen
 * and on the way out, and the window can answer `isFullscreen()` — so the answer
 * is re-asked on every resize, with **at most one question outstanding**. A live
 * resize drag fires at frame rate, and one invoke per frame for an answer that
 * cannot have changed is the kind of cost this app does not pay.
 *
 * Nothing here blocks or is awaited. The state starts at what an ordinary macOS
 * window is, and the first answer lands after the window has painted; being
 * wrong for a frame costs a row 68px of leading space.
 */
export function tauriWindowControls(deps?: {
  /**
   * Injected so the platform branch is testable without a WebView. The default
   * is the user agent, which is the one platform fact a WebView carries without
   * a plugin, a permission or an invoke.
   */
  readonly isMacOS?: boolean;
}): WindowControls {
  const isMacOS = deps?.isMacOS ?? navigator.userAgent.includes("Mac OS X");
  if (!isMacOS) return NO_OVERLAID_CONTROLS;

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
        // A window that will not say is assumed to be an ordinary one: the cost
        // of being wrong is cosmetic, and a client that cannot ask has nothing
        // better to go on than the shape every window has.
        isAsking = false;
        return undefined;
      },
    );
  };

  // Asked once here, so a window that opens into a restored fullscreen Space is
  // not waiting for a resize that may never come. The subscription lives as long
  // as the process — there is one window, and this is it.
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
