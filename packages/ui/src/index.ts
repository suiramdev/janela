export { MainWindow } from "./pages/main-window/index.ts";

export { SettingsScreen } from "./pages/settings/index.ts";

export {
  ClientEnvironmentProvider,
  createConfirmationQueue,
  createViewState,
  CONFIRMATION_KEYS,
  DEFAULT_GLOBAL_SETTINGS,
  TERMINAL_FONT_SIZE_BOUNDS,
  withSilencedConfirmation,
  withTerminalFontSize,
  type ClientEnvironment,
  type Clipboard,
  type CommandSource,
  type ConfirmationKey,
  type GlobalSettings,
  type NativeShell,
  type SettingsRoute,
  type SettingsStoring,
  type WindowControls,
} from "./shared/model/index.ts";

export { COMMANDS, isCommandID, type CommandID } from "./shared/config/index.ts";

export { TRAFFIC_LIGHT_POSITION } from "./shared/ui/index.ts";
