import type { SessionStore } from "@janela/client";
import {
  emptyLayout,
  type ProjectID,
  type SessionID,
  type SessionLayout,
  type TerminalID,
} from "@janela/core";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";

import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "./global-settings.ts";
import { resolveLocalLayout, withFocusedTerminal, type LocalLayoutEntry } from "./layout-edits.ts";
import type { SettingsTabID } from "./settings-window.tsx";

/**
 * What this client is looking at, as a store.
 *
 * ## Why it is a store and not component state
 *
 * Pane focus used to live in `SessionDetail`'s `useState`, which was fine while the
 * only thing that moved focus was a click. It is not fine now: a menu chord, the
 * jump list and a notification click all have to reach the same focus, and each of
 * them originates outside the React tree that holds it. **`focusTerminal` is the
 * single entry point** — if a second way to move pane focus appears, the two will
 * disagree the first time a notification arrives while the palette is open.
 *
 * ## What is in here, and what is not
 *
 * Everything here is *this window's view of the mirror*: which panes are focused,
 * which screen and sheet are showing, the settings the WebView renders with. None
 * of it is on the wire, and none of it is invented state about sessions — the
 * mirror is still the only source for what exists. Session **selection**
 * deliberately stays on `SessionStore`, because that is where the sidebar already
 * reads it.
 */
export type Sheet =
  | { readonly kind: "jumpList" }
  | { readonly kind: "commands" }
  /** A session in `projectID`: which branch, and whether it gets a worktree. */
  | { readonly kind: "newSession"; readonly projectID: ProjectID }
  /**
   * `projectID` is the project a *context menu* was opened over, which is
   * frequently not the selected session's project. Absent when the sheet was
   * opened from the menu bar, where the selection is the only subject there is.
   */
  | { readonly kind: "newBranch"; readonly projectID?: ProjectID }
  | { readonly kind: "projectSettings"; readonly projectID: ProjectID };

/**
 * What fills the window.
 *
 * Settings is a screen rather than a sheet: it replaces the sidebar with its own
 * navigation and the terminals with the chosen pane, and the only way back is the
 * button at the bottom of that navigation. A modal over the terminals would leave
 * the user reading settings through a scrim, and the tab strip it needs has no
 * room in a dialog.
 */
export type Screen =
  | { readonly kind: "workspace" }
  | { readonly kind: "settings"; readonly tab: SettingsTabID };

export interface ViewState {
  /** Local layout edits, keyed by session. Resolved against the mirror on read. */
  readonly layouts: ReadonlyMap<SessionID, LocalLayoutEntry>;

  /** The one sheet that is open, if any. There is never more than one. */
  readonly sheet: Sheet | undefined;

  readonly screen: Screen;

  readonly settings: GlobalSettings;

  /**
   * Edits the on-screen layout of `sessionID`.
   *
   * The mirror is read here, at the moment of the edit, rather than captured from
   * a render: an edit applies to the layout that is on screen now, and the mirror
   * may have replaced it since the caller was created.
   */
  applyLayout(sessionID: SessionID, change: (layout: SessionLayout) => SessionLayout): void;

  /**
   * Selects the session holding `terminalID`, focuses its tab and its pane, and
   * gives the surface keyboard focus if it is mounted.
   *
   * **The** focus entry point. An unknown id does nothing and notifies nobody: a
   * notification for a terminal the mirror has since dropped is not an error.
   */
  focusTerminal(terminalID: TerminalID): void;

  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  setSettings(settings: GlobalSettings): void;

  /**
   * Shows the settings screen. Without a tab, stays on the tab already showing
   * when settings is open, and opens on General otherwise — so ⌘, pressed twice
   * does not send someone back to the first tab.
   */
  showSettings(tab?: SettingsTabID): void;
  /** Back to the terminals. Nothing when they are already showing. */
  showWorkspace(): void;

  /**
   * Registers a mounted terminal surface, returning its unregistration.
   *
   * Mounted surfaces are how Clear Scrollback reaches a viewport and how focus
   * returns to the terminal when a sheet closes. A pane in an unfocused tab is not
   * mounted, so an absent handle is normal.
   */
  registerSurface(terminalID: TerminalID, handle: TerminalSurfaceHandle): () => void;
  surface(terminalID: TerminalID): TerminalSurfaceHandle | undefined;

  subscribe(listener: () => void): () => void;
}

const NO_LAYOUTS: ReadonlyMap<SessionID, LocalLayoutEntry> = new Map<SessionID, LocalLayoutEntry>();
const WORKSPACE: Screen = { kind: "workspace" };

export function createViewState(sessions: SessionStore): ViewState {
  let layouts = NO_LAYOUTS;
  let sheet: Sheet | undefined;
  let screen: Screen = WORKSPACE;
  let settings = DEFAULT_GLOBAL_SETTINGS;

  // Surfaces are not part of the notified state: they are mount bookkeeping, and a
  // pane registering itself must not re-render the tree that just mounted it.
  const surfaces = new Map<TerminalID, TerminalSurfaceHandle>();

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const applyLayout = (
    sessionID: SessionID,
    change: (layout: SessionLayout) => SessionLayout,
  ): void => {
    const live = sessions.sessions.find((candidate) => candidate.id === sessionID);
    const mirror = live?.layout ?? emptyLayout;
    const ids = (live?.terminals ?? []).map((terminal) => terminal.id);

    const resolved = resolveLocalLayout(layouts.get(sessionID), mirror, ids);
    const local = change(resolved.local);
    // A change that changed nothing is not a notification: `focusNeighbour` on a
    // single pane, or focusing the pane that already has focus, happens constantly.
    if (local === resolved.local) return;

    layouts = new Map(layouts).set(sessionID, { base: resolved.base, local });
    notify();
  };

  return {
    get layouts(): ReadonlyMap<SessionID, LocalLayoutEntry> {
      return layouts;
    },
    get sheet(): Sheet | undefined {
      return sheet;
    },
    get screen(): Screen {
      return screen;
    },
    get settings(): GlobalSettings {
      return settings;
    },

    applyLayout,

    focusTerminal(terminalID: TerminalID): void {
      const owner = sessions.sessions.find((session) =>
        session.terminals.some((terminal) => terminal.id === terminalID),
      );
      if (owner === undefined) return;

      sessions.selection = owner.id;
      applyLayout(owner.id, (layout) => withFocusedTerminal(layout, terminalID));
      // May be unmounted: the pane it belongs to renders after this notification,
      // and `TerminalSurface` focuses itself when its `focused` prop becomes true.
      surfaces.get(terminalID)?.focus();
    },

    openSheet(next: Sheet): void {
      sheet = next;
      notify();
    },

    closeSheet(): void {
      if (sheet === undefined) return;
      sheet = undefined;
      notify();
    },

    setSettings(next: GlobalSettings): void {
      if (settings === next) return;
      settings = next;
      notify();
    },

    showSettings(tab?: SettingsTabID): void {
      const next = tab ?? (screen.kind === "settings" ? screen.tab : "general");
      if (screen.kind === "settings" && screen.tab === next) return;
      screen = { kind: "settings", tab: next };
      notify();
    },

    showWorkspace(): void {
      if (screen.kind === "workspace") return;
      screen = WORKSPACE;
      notify();
    },

    registerSurface(terminalID: TerminalID, handle: TerminalSurfaceHandle): () => void {
      surfaces.set(terminalID, handle);
      return () => {
        // Only if it is still ours: a remount registers the new handle before the
        // old one's cleanup runs, and deleting unconditionally would drop it.
        if (surfaces.get(terminalID) === handle) surfaces.delete(terminalID);
      };
    },

    surface(terminalID: TerminalID): TerminalSurfaceHandle | undefined {
      return surfaces.get(terminalID);
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
