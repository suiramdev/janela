import type { SessionStore } from "@janela/client";
import {
  emptyLayout,
  type ProjectID,
  type SessionID,
  type SessionLayout,
  type TerminalID,
} from "@janela/core";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";

import type { AppUpdateState } from "./app-update.ts";
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "./global-settings.ts";
import { type LocalLayoutEntry, resolveLocalLayout, withFocusedTerminal } from "./local-layout.ts";
import { EMPTY_SETTINGS_DRAFT, type SettingsDraft } from "./settings-draft.ts";

export type Sheet =
  | { readonly kind: "jumpList" }
  | { readonly kind: "commands" }
  | { readonly kind: "newSession"; readonly projectID?: ProjectID };

export type SettingsTabID =
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "integrations"
  | "permissions";

export type SettingsRoute =
  | { readonly kind: "tab"; readonly tab: SettingsTabID }
  | { readonly kind: "project"; readonly projectID: ProjectID };

export type Screen =
  | { readonly kind: "workspace" }
  | { readonly kind: "settings"; readonly route: SettingsRoute };

export interface ViewState {
  readonly layouts: ReadonlyMap<SessionID, LocalLayoutEntry>;

  readonly sheet: Sheet | undefined;

  readonly screen: Screen;

  readonly settings: GlobalSettings;

  readonly isRecordingShortcut: boolean;

  readonly appUpdate: AppUpdateState;

  applyLayout(sessionID: SessionID, change: (layout: SessionLayout) => SessionLayout): void;

  focusTerminal(terminalID: TerminalID): void;

  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  setSettings(settings: GlobalSettings): void;
  setRecordingShortcut(isRecording: boolean): void;
  setAppUpdate(state: AppUpdateState): void;

  readonly settingsDraft: SettingsDraft;
  readonly savedSettingsDraft: SettingsDraft;
  readonly hasUnsavedSettings: boolean;

  editSettingsDraft(draft: SettingsDraft): void;
  settingsDraftSaved(): void;
  revertSettingsDraft(): void;

  showSettings(route?: SettingsRoute): void;
  showWorkspace(): void;

  registerSurface(terminalID: TerminalID, handle: TerminalSurfaceHandle): () => void;
  surface(terminalID: TerminalID): TerminalSurfaceHandle | undefined;

  subscribe(listener: () => void): () => void;
}

const NO_LAYOUTS: ReadonlyMap<SessionID, LocalLayoutEntry> = new Map<SessionID, LocalLayoutEntry>();

const WORKSPACE: Screen = { kind: "workspace" };

const FIRST_TAB: SettingsRoute = { kind: "tab", tab: "appearance" };

export function sameRoute(left: SettingsRoute, right: SettingsRoute): boolean {
  return left.kind === "tab"
    ? right.kind === "tab" && left.tab === right.tab
    : right.kind === "project" && left.projectID === right.projectID;
}

export function createViewState(sessions: SessionStore): ViewState {
  let layouts = NO_LAYOUTS;
  let sheet: Sheet | undefined;
  let screen: Screen = WORKSPACE;
  let settings = DEFAULT_GLOBAL_SETTINGS;
  let settingsDraft = EMPTY_SETTINGS_DRAFT;
  let savedSettingsDraft = EMPTY_SETTINGS_DRAFT;
  let isRecordingShortcut = false;
  let appUpdate: AppUpdateState = { kind: "idle" };

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
    get isRecordingShortcut(): boolean {
      return isRecordingShortcut;
    },
    get appUpdate(): AppUpdateState {
      return appUpdate;
    },
    get settingsDraft(): SettingsDraft {
      return settingsDraft;
    },
    get savedSettingsDraft(): SettingsDraft {
      return savedSettingsDraft;
    },
    get hasUnsavedSettings(): boolean {
      return settingsDraft !== savedSettingsDraft;
    },

    applyLayout,

    focusTerminal(terminalID: TerminalID): void {
      const owner = sessions.sessions.find((session) =>
        session.terminals.some((terminal) => terminal.id === terminalID),
      );

      if (owner === undefined) return;

      sessions.selection = owner.id;
      applyLayout(owner.id, (layout) => withFocusedTerminal(layout, terminalID));
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

    setRecordingShortcut(next: boolean): void {
      if (isRecordingShortcut === next) return;

      isRecordingShortcut = next;
      notify();
    },

    setAppUpdate(next: AppUpdateState): void {
      appUpdate = next;
      notify();
    },

    editSettingsDraft(next: SettingsDraft): void {
      if (settingsDraft === next) return;

      settingsDraft = next;
      notify();
    },

    settingsDraftSaved(): void {
      if (savedSettingsDraft === settingsDraft) return;

      savedSettingsDraft = settingsDraft;
      notify();
    },

    revertSettingsDraft(): void {
      if (settingsDraft === savedSettingsDraft) return;

      settingsDraft = savedSettingsDraft;
      notify();
    },

    showSettings(route: SettingsRoute | undefined): void {
      const next = route ?? (screen.kind === "settings" ? screen.route : FIRST_TAB);

      if (screen.kind === "settings" && sameRoute(screen.route, next)) return;

      screen = { kind: "settings", route: next };
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
