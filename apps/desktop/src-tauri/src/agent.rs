//! LaunchAgent registration, and the two `launchctl` calls around it.
//!
//! ## What registration is for, and what it is not
//!
//! Registering makes launchd own the daemon's lifecycle, so terminals survive the
//! app quitting. It starts nothing: the plist has no `RunAtLoad`, and the app
//! never starts the daemon on the launch path (ADR 0017, amended 2026-09-08).
//!
//! `"requires-approval"` is a **supported state, not an error**: the app runs in a
//! degraded mode — terminals that die when it quits — and says so plainly with a
//! link to the right settings pane. Refusing to work at all would be worse.
//!
//! ## The plist is sealed
//!
//! It is signed into the bundle at build time and **MUST NOT be written at
//! runtime**: `smd` checks the bundle's static code signature before loading it,
//! so a plist added or edited after signing fails with `errSecCSBadResource`
//! (-67054) on every signed install — the failure that shows up on a user's
//! machine and never in CI. Nothing here writes one.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex as SyncMutex, MutexGuard};
use std::time::{Duration, Instant};

use objc2_foundation::NSString;
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// The agent's label, and the plist that names it. Both must match the sealed
/// file at `Contents/Library/LaunchAgents/sh.janela.janelad.plist` (#39).
const LAUNCH_AGENT_LABEL: &str = "sh.janela.janelad";
const LAUNCH_AGENT_PLIST: &str = "sh.janela.janelad.plist";

/// The sidecar, at the path the bundler puts it and the plist's `BundleProgram`
/// names. A missing one is a damaged install.
const SIDECAR_NAME: &str = "janelad";

/// Shortest interval between two `launchctl kickstart` runs.
///
/// The client retries with backoff starting at 250 ms, and asking launchd to start
/// a daemon it is already starting achieves nothing but a process spawn per
/// attempt.
const KICKSTART_THROTTLE: Duration = Duration::from_secs(1);

/// What the app knows about the agent. Crosses to the WebView as a plain string,
/// where `LaunchAgentStatus` in `environment.ts` is the same closed set.
const STATUS_UNSUPPORTED: &str = "unsupported";
const STATUS_REGISTERED: &str = "registered";
const STATUS_REQUIRES_APPROVAL: &str = "requires-approval";
const STATUS_NOT_FOUND: &str = "not-found";

/// The `.app` bundle this executable lives in, if it lives in one.
///
/// A development build runs the binary straight out of `target/`, where there is
/// no bundle, no sealed plist and nothing to register. That is `unsupported`, and
/// the honest answer rather than an error.
fn bundle_macos_directory() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    Some(macos.to_path_buf())
}

fn describe(status: SMAppServiceStatus) -> &'static str {
    match status {
        SMAppServiceStatus::Enabled => STATUS_REGISTERED,
        SMAppServiceStatus::RequiresApproval => STATUS_REQUIRES_APPROVAL,
        _ => STATUS_NOT_FOUND,
    }
}

/// The agent, or `None` when there is nothing to register.
///
/// Two refusals, and they are different: no bundle is a development build
/// (`unsupported`), and a bundle with no sidecar beside the executable is a
/// damaged install (`not-found`) — reported, never registered.
fn agent() -> Result<objc2::rc::Retained<SMAppService>, &'static str> {
    let macos = bundle_macos_directory().ok_or(STATUS_UNSUPPORTED)?;
    if !Path::new(&macos).join(SIDECAR_NAME).exists() {
        return Err(STATUS_NOT_FOUND);
    }
    let name = NSString::from_str(LAUNCH_AGENT_PLIST);
    Ok(unsafe { SMAppService::agentServiceWithPlistName(&name) })
}

#[tauri::command]
pub fn launch_agent_status() -> String {
    match agent() {
        Err(reason) => reason.to_string(),
        Ok(service) => describe(unsafe { service.status() }).to_string(),
    }
}

/// Registers the agent if it is not registered already.
///
/// Idempotent from the caller's side: an already-registered agent reports
/// `registered` without a second registration, and a registration refused for
/// approval reports `requires-approval` rather than failing.
#[tauri::command]
pub fn register_launch_agent() -> Result<String, String> {
    let service = match agent() {
        // Not an `Err`: a development build has nothing to register, and the app
        // must not present that as a failure.
        Err(reason) => return Ok(reason.to_string()),
        Ok(service) => service,
    };

    let status = unsafe { service.status() };
    if status != SMAppServiceStatus::NotRegistered {
        return Ok(describe(status).to_string());
    }

    // One attempt. `registerAndReturnError` fails when the user has denied
    // consent, so the status afterwards is the answer rather than the error's
    // code — approval pending and already-registered both read correctly.
    let attempt = unsafe { service.registerAndReturnError() };
    let settled = describe(unsafe { service.status() });
    match attempt {
        Ok(()) => Ok(settled.to_string()),
        Err(_) if settled != STATUS_NOT_FOUND => Ok(settled.to_string()),
        Err(error) => Err(format!("registration failed ({})", error.code())),
    }
}

/// Opens System Settings at Login Items & Extensions.
///
/// The other half of reporting `requires-approval` honestly: the app says what is
/// wrong and takes the user to where they can fix it.
#[tauri::command]
pub fn open_login_items_settings() {
    unsafe { SMAppService::openSystemSettingsLoginItems() };
}

fn launchctl(arguments: &[&str]) -> Result<(), String> {
    let status = Command::new("/bin/launchctl")
        .args(arguments)
        .status()
        .map_err(|_| "launchctl could not be run".to_string())?;
    if status.success() {
        return Ok(());
    }
    Err(format!("launchctl exited {}", status.code().unwrap_or(-1)))
}

fn service_target() -> String {
    // `gui/<uid>` is the login session's domain, which is where an agent lives.
    format!("gui/{}/{}", unsafe { libc::getuid() }, LAUNCH_AGENT_LABEL)
}

/// Stops the daemon, hanging up every terminal it holds.
///
/// `SIGTERM`, so the daemon hangs up its PTYs and exits 0 — and
/// `KeepAlive.SuccessfulExit=false` respects a deliberate exit, so launchd leaves
/// it down. **The UI must state that cost before calling this**: it kills the
/// user's terminals, which is only ever their explicit choice (non-negotiable #7).
#[tauri::command]
pub fn stop_background_service() -> Result<(), String> {
    launchctl(&["kill", "TERM", &service_target()])
}

/// Asks launchd to start the daemon, at most once per `KICKSTART_THROTTLE`.
///
/// No `-k`: a running service must be left alone. This is the replacement for
/// socket activation — nothing runs until a client cannot connect, so a user who
/// never opens Janela never has a process.
pub fn kickstart(last: &SyncMutex<Option<Instant>>) {
    let mut guard: MutexGuard<'_, Option<Instant>> =
        last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    if let Some(previous) = *guard {
        if now.duration_since(previous) < KICKSTART_THROTTLE {
            return;
        }
    }
    *guard = Some(now);
    drop(guard);

    // Deliberately ignored: the client is already retrying, and a `launchctl`
    // failure it cannot act on is not worth a dialog. The failure the user sees
    // is the connection not coming up.
    let _ = launchctl(&["kickstart", &service_target()]);
}
