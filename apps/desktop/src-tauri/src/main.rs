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
// The daemon is a compiled Bun binary shipped as a Tauri sidecar. launchd owns its
// lifecycle through a LaunchAgent inside the bundle, socket-activated, so the *app*
// does not start it — it connects, and launchd starts it on first connection. The
// app's job is registration, reporting an approval requirement honestly, and never
// terminating a running daemon on its own.
//
// Note the sidecar is a single file: `bun build --compile` embeds the runtime, the
// Prisma client, the emulator and the PTY cdylib. Verified during the migration, and
// it is what keeps ADR 0008's signing story at two binaries rather than three.

fn main() {}
