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

// TODO: The socket bridge. Connect to `~/.janela/run/janelad.sock`, read
// length-prefixed frames, and relay them to the WebView as raw bytes — never base64,
// never JSON-wrapped. Relay input and control frames the other way.
//
// Back-pressure lives here, on the daemon→WebView direction, and the two policies
// are different: coalesced repaint frames may drop their oldest, control frames and
// input may not. Getting this wrong shows up as a terminal that is subtly corrupt
// after a stall, which is the worst kind of bug to find late.

// TODO: Sidecar lifecycle and launch-agent registration.
//
// The daemon is a compiled Bun binary shipped as a Tauri sidecar, at
// `Contents/MacOS/janelad` — the bundler's location, and what the sealed LaunchAgent
// plist names as its `BundleProgram`. launchd owns its lifecycle through that agent,
// registered with `SMAppService.agent(plistName: "sh.janela.janelad.plist")`.
//
// There is no socket activation (ADR 0017, amended 2026-09-08): the agent has no
// `RunAtLoad`, so registering starts nothing. The daemon binds
// `~/.janela/run/janelad.sock` itself, and a client that cannot connect starts it
// with `launchctl kickstart gui/<uid>/sh.janela.janelad` and retries. The app's job
// is registration, reporting an approval requirement honestly, and never terminating
// a running daemon on its own.
//
// The plist is sealed by the code signature and MUST NOT be written at runtime: `smd`
// checks the bundle's signature before loading it, and a rewritten plist fails with
// `errSecCSBadResource`. Before registering, check that the sidecar exists beside the
// current executable; a missing one is a damaged install, which is reported rather
// than registered.
//
// Note the sidecar is a single file: `bun build --compile` embeds the runtime, the
// Prisma client, the emulator and the PTY cdylib. Verified during the migration, and
// it is what keeps ADR 0008's signing story at two binaries rather than three.

use std::time::Instant;

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
        .run(tauri::generate_context!())
        .expect("failed to run the Janela shell");
}
