//! Janela's Tauri shell.
//!
//! Deliberately thin, and the list of what belongs here is closed:
//!
//!   * the window, and its native chrome
//!   * the native menu bar and its accelerators
//!   * native notifications
//!   * native file dialogs — **the app performs file selection; the daemon is handed
//!     paths.** That is a rule, not a convenience: it is what keeps macOS permission
//!     prompts attributed to the app the user just clicked rather than to a
//!     background binary they have never heard of
//!     (docs/decisions/0017-daemon-lifecycle.md § TCC attribution).
//!   * the daemon sidecar's lifecycle and launch-agent registration
//!   * **the Unix-socket bridge**, because a WebView cannot open a socket
//!
//! What does not belong here: anything about projects, sessions, terminals or the
//! protocol's meaning. This shell relays frames; it does not read them. If Rust code
//! here starts needing to know what a `StateUpdate` is, the boundary has moved and
//! the reason should be an ADR.
//!
//! See docs/decisions/0023-macos-first-portable.md.

// TODO: The window and the native menu, built from @janela/ui's COMMANDS table so the
// menu and the in-app command palette cannot drift apart.

// The socket bridge is `bridge.rs`: it relays length-prefixed frames as raw bytes
// in both directions and applies the two back-pressure policies — coalesced
// repaints may drop their oldest, control frames and input may not. Getting that
// wrong shows up as a terminal that is subtly corrupt after a stall.
//
// Launch-agent registration is `agent.rs`: `SMAppService.agent(plistName:)` over
// the plist sealed into `Contents/Library/LaunchAgents`, with
// `launchctl kickstart` standing in for socket activation (ADR 0017, amended
// 2026-09-08). The sidecar is a single compiled Bun binary at
// `Contents/MacOS/janelad`, which is what keeps ADR 0008's signing story at two
// binaries rather than three. Neither module reads a frame's meaning, and neither
// writes a plist.

mod agent;
mod bridge;

use std::time::Instant;

use agent::{
    launch_agent_status, open_login_items_settings, register_launch_agent, stop_background_service,
};
use bridge::{bridge_close, bridge_connect, bridge_receive, bridge_send, BridgeState};

use tauri::webview::PageLoadEvent;

fn main() {
    // Launch budget instrument (docs/performance.md § Launch): `main` → the WebView
    // reports the page loaded. Process start → `main` is dyld work this cannot see;
    // the JS side logs navigation → first frame separately.
    let launched_at = Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!(
                    target: "app",
                    "window loaded {} ms after main",
                    launched_at.elapsed().as_millis()
                );
            }
        })
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            bridge_connect,
            bridge_receive,
            bridge_send,
            bridge_close,
            launch_agent_status,
            register_launch_agent,
            open_login_items_settings,
            stop_background_service,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Janela shell");
}
