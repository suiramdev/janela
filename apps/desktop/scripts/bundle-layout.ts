/**
 * What Janela.app must contain, as constants.
 *
 * The bundle's shape is a contract between three places that cannot import each
 * other: `tauri.conf.json` (which builds it), the LaunchAgent plist (which names the
 * daemon's path inside it), and the registration code in the Tauri shell (#30). This
 * file is the TypeScript side of it, and `bundle-verification.ts` is what stops the
 * three drifting apart silently.
 */

/** `productName` in `tauri.conf.json`, and therefore the bundle's directory name. */
export const APP_NAME = "Janela";

/**
 * The Cargo binary's name, which is what the bundler writes into `Contents/MacOS` and
 * into `Info.plist`'s `CFBundleExecutable` — lowercase, and *not* `productName`.
 * Checked against `Info.plist` rather than only looked up on disk: macOS filesystems
 * are case-insensitive by default, so `existsSync` alone would happily accept the
 * wrong name and then fail on a case-sensitive volume.
 */
export const MAIN_EXECUTABLE_NAME = "janela";

/** The sidecar's name once Tauri strips the target triple from `binaries/janelad-<triple>`. */
export const SIDECAR_NAME = "janelad";

/** The LaunchAgent's label, and therefore its `launchctl` service name (ADR 0017). */
export const LAUNCH_AGENT_LABEL = "sh.janela.janelad";

export const MAIN_EXECUTABLE = `Contents/MacOS/${MAIN_EXECUTABLE_NAME}`;

/**
 * Tauri's bundler copies `externalBin` into `Contents/MacOS`, not
 * `Contents/Resources` — Apple treats a Mach-O under `Resources` as data rather than
 * code, and the bundler signs what is in `MacOS`. This string is also the plist's
 * `BundleProgram`, which is relative to the bundle root.
 */
export const SIDECAR_BUNDLE_PROGRAM = `Contents/MacOS/${SIDECAR_NAME}`;

/**
 * Where a sidecar would land if someone "fixed" the layout to match the older ADRs.
 * A Mach-O there is not signed by the bundler, so it must never exist.
 */
export const MISPLACED_SIDECAR = `Contents/Resources/${SIDECAR_NAME}`;

/** The plist's path in the code signature's sealed-resource list (relative to `Contents/`). */
export const LAUNCH_AGENT_SEALED_RESOURCE = `Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`;

export const LAUNCH_AGENT_PLIST = `Contents/${LAUNCH_AGENT_SEALED_RESOURCE}`;

/** Both keys are measured, not defensive. See `src-tauri/Entitlements.plist`. */
export const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation",
] as const;

/** Its absence *is* "App Sandbox off" (ADR 0008), so the absence is what we assert. */
export const FORBIDDEN_ENTITLEMENTS = ["com.apple.security.app-sandbox"] as const;

/**
 * Top-level plist keys that would undo a decision.
 *
 * - `Sockets`: socket activation was dropped (ADR 0017, amended 2026-09-08 by #39).
 *   The daemon binds `~/.janela/run/janelad.sock` itself; a launchd-owned socket
 *   publishes its path only into the GUI login session.
 * - `Program`, `ProgramArguments`: an absolute path to a binary inside the bundle,
 *   which is user-specific. `BundleProgram` is the relative form SMAppService wants.
 * - `RunAtLoad`: registering the agent must not start a daemon nobody asked for.
 */
export const FORBIDDEN_LAUNCH_AGENT_KEYS = [
  "Sockets",
  "Program",
  "ProgramArguments",
  "RunAtLoad",
] as const;

/** Relative to `apps/desktop`. Where `tauri build` leaves the bundle. */
export const DEFAULT_BUNDLE_PATH = `src-tauri/target/release/bundle/macos/${APP_NAME}.app`;
