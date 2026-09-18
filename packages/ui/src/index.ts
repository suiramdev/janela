export { DirectoryPickerHost, MainWindow } from "./pages/main-window/index.ts";

export { SettingsScreen } from "./pages/settings/index.ts";

export {
  ClientEnvironmentProvider,
  commandsWithShortcuts,
  createConfirmationQueue,
  createDirectoryPickerQueue,
  createViewState,
  CONFIRMATION_KEYS,
  DEFAULT_GLOBAL_SETTINGS,
  NO_WINDOW_CONTROLS,
  TERMINAL_FONT_SIZE_BOUNDS,
  withSilencedConfirmation,
  withTerminalFontSize,
  withTheme,
  type AppearanceControl,
  type ClientEnvironment,
  type Clipboard,
  type CommandSource,
  type ConfirmationKey,
  type DirectoryPickerQueue,
  type DirectoryPicking,
  type GlobalSettings,
  type LocalShell,
  type NativeShell,
  type NotificationSoundControlling,
  type SettingsRoute,
  type SettingsStoring,
  type ThemePreference,
  type WindowControls,
} from "./shared/model/index.ts";

export { COMMANDS, isCommandID, type Command, type CommandID } from "./shared/config/index.ts";

export {
  browserClipboard,
  keyboardCommandSource,
  localStorageSettings,
  type ChordTarget,
} from "./shared/lib/web-platform/index.ts";

export { TRAFFIC_LIGHT_POSITION } from "./shared/ui/index.ts";
