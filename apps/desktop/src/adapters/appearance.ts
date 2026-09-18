import type { AppearanceControl, ThemePreference } from "@janela/ui";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";

export type WindowThemeSetter = (theme: Theme | null) => Promise<void>;

export type DockIconSetter = (appearance: Theme) => Promise<void>;

export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

interface AppearanceDeps {
  readonly setTheme?: WindowThemeSetter | undefined;
  readonly setDockIcon?: DockIconSetter | undefined;
  readonly darkScheme?: SchemeQuery | undefined;
}

const DARK_SCHEME = "(prefers-color-scheme: dark)";

export function windowTheme(theme: ThemePreference): Theme | null {
  return theme === "system" ? null : theme;
}

export function tauriAppearance(deps: AppearanceDeps = {}): AppearanceControl {
  const setTheme = deps.setTheme ?? ((theme) => getCurrentWindow().setTheme(theme));
  const setDockIcon =
    deps.setDockIcon ?? ((appearance) => invoke<void>("set_dock_icon", { appearance }));
  const darkScheme = deps.darkScheme ?? window.matchMedia(DARK_SCHEME);

  const syncDock = (): Promise<void> => setDockIcon(darkScheme.matches ? "dark" : "light");

  darkScheme.addEventListener("change", () => {
    void syncDock().catch(() => undefined);
  });

  return {
    async apply(theme): Promise<void> {
      await setTheme(windowTheme(theme));
      await syncDock();
    },
  };
}
