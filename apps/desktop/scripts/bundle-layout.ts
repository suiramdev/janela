export const APP_NAME = "Janela";

export const MAIN_EXECUTABLE_NAME = "janela";

export const SIDECAR_NAME = "janelad";

export const LAUNCH_AGENT_LABEL = "sh.janela.janelad";

export const MAIN_EXECUTABLE = `Contents/MacOS/${MAIN_EXECUTABLE_NAME}`;

export const SIDECAR_BUNDLE_PROGRAM = `Contents/MacOS/${SIDECAR_NAME}`;

export const MISPLACED_SIDECAR = `Contents/Resources/${SIDECAR_NAME}`;

export const LAUNCH_AGENT_SEALED_RESOURCE = `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`;

export const LAUNCH_AGENT_PLIST = `Contents/${LAUNCH_AGENT_SEALED_RESOURCE}`;

export const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation",
] as const;

export const FORBIDDEN_ENTITLEMENTS = ["com.apple.security.app-sandbox"] as const;

export const FORBIDDEN_LAUNCH_AGENT_KEYS = [
  "Sockets",
  "Program",
  "ProgramArguments",
  "RunAtLoad",
  "StandardOutPath",
  "StandardErrorPath",
] as const;

export const DEFAULT_BUNDLE_PATH = `src-tauri/target/release/bundle/macos/${APP_NAME}.app`;
