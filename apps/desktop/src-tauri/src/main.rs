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

// The native menu is built at runtime from `@janela/ui`'s `COMMANDS`, which the
// frontend sends once at startup (`install_menu` below). The shell reads ids,
// titles, accelerators and which menu a row goes in — and nothing else. It does
// not know what any command *means*, which is what stops the menu bar and the
// in-app command palette drifting apart: there is one table, in TypeScript, and
// adding a row to it needs no Rust change.

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

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use agent::{
    launch_agent_status, open_login_items_settings, register_launch_agent, stop_background_service,
    unregister_launch_agent,
};
use bridge::{bridge_close, bridge_connect, bridge_receive, bridge_send, BridgeState};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Wry};

/// The event a chosen menu item arrives on.
///
/// Paired with `COMMAND_EVENT` in `apps/desktop/src/menu.ts`; the two spellings
/// must match, and there is deliberately no third place that knows this string.
pub const COMMAND_EVENT: &str = "janela://command";

/// One row of `COMMANDS`, as it crosses from the WebView.
///
/// Everything the shell needs to draw a menu and nothing more. `section` groups
/// rows within a menu: a change of section becomes a separator.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandSpec {
    id: String,
    title: String,
    accelerator: Option<String>,
    menu: String,
    section: Option<u32>,
}

/// Builds the menu bar from the table and installs it.
///
/// Called after the page loads. Building it before then would need the table in
/// Rust, which is exactly the duplication this design exists to avoid — at the
/// cost of the default menu being visible for the first few frames.
///
/// **Exactly once per process.** A second `set_menu` does not retire the first
/// menu's key equivalents: both stay registered with AppKit, and one ⌘D then
/// splits twice. The table is a constant for the life of the process, so the
/// second call has nothing to add — and in development the frontend remounts on
/// every hot reload, which is how this was found.
#[tauri::command]
fn install_menu(app: AppHandle, commands: Vec<CommandSpec>) -> Result<(), String> {
    if MENU_INSTALLED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let rows = |menu: &str| -> Vec<&CommandSpec> {
        commands.iter().filter(|spec| spec.menu == menu).collect()
    };

    for spec in &commands {
        if !MENUS.contains(&spec.menu.as_str()) {
            return Err(format!("unknown menu {}", spec.menu));
        }
    }

    // The application menu. macOS expects Settings, About and Quit here, and a
    // Mac user looks for them under the app's name before anywhere else.
    let mut app_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![Box::new(
        PredefinedMenuItem::about(&app, None, None).map_err(to_message)?,
    )];
    app_items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(to_message)?,
    ));
    push_rows(&app, &mut app_items, &rows("app"))?;
    app_items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::services(&app, None).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::hide(&app, None).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::hide_others(&app, None).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::show_all(&app, None).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(to_message)?,
    ));
    app_items.push(Box::new(
        PredefinedMenuItem::quit(&app, None).map_err(to_message)?,
    ));
    let app_menu = submenu(&app, "Janela", app_items)?;

    let file = submenu_of_rows(&app, "File", &rows("file"))?;

    // Edit is entirely predefined, and that is the point: these are what route
    // ⌘C, ⌘V and ⌘Z to the WebView, where the terminal handles the DOM `copy` and
    // `paste` events itself. They are not commands, so they are not in the table.
    let edit_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![
        Box::new(PredefinedMenuItem::undo(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::redo(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::separator(&app).map_err(to_message)?),
        Box::new(PredefinedMenuItem::cut(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::copy(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::paste(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::select_all(&app, None).map_err(to_message)?),
    ];
    let edit = submenu(&app, "Edit", edit_items)?;

    let view = submenu_of_rows(&app, "View", &rows("view"))?;
    let session = submenu_of_rows(&app, "Session", &rows("session"))?;
    let terminal = submenu_of_rows(&app, "Terminal", &rows("terminal"))?;

    // No Close Window: ⌘W closes a *pane*, and a window holding a running agent is
    // not something to close by reflex (ADR 0010, amended). No Enter Full Screen
    // either — its default chord is ⌃⌘F, and `Ctrl` belongs to the terminal.
    let window_items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = vec![
        Box::new(PredefinedMenuItem::minimize(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::maximize(&app, None).map_err(to_message)?),
        Box::new(PredefinedMenuItem::separator(&app).map_err(to_message)?),
        Box::new(PredefinedMenuItem::bring_all_to_front(&app, None).map_err(to_message)?),
    ];
    let window = submenu(&app, "Window", window_items)?;
    window.set_as_windows_menu_for_nsapp().map_err(to_message)?;

    let menu = Menu::with_items(
        &app,
        &[&app_menu, &file, &edit, &view, &session, &terminal, &window],
    )
    .map_err(to_message)?;
    app.set_menu(menu).map_err(to_message)?;
    Ok(())
}

/// Whether the menu bar has been built. See `install_menu`.
static MENU_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Every menu the table may name. An unknown one is a bug in the table, not a row
/// to silently drop.
const MENUS: [&str; 5] = ["app", "file", "view", "session", "terminal"];

fn to_message(error: tauri::Error) -> String {
    error.to_string()
}

fn submenu(
    app: &AppHandle,
    title: &str,
    items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>,
) -> Result<Submenu<Wry>, String> {
    let references: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        items.iter().map(std::convert::AsRef::as_ref).collect();
    Submenu::with_items(app, title, true, &references).map_err(to_message)
}

fn submenu_of_rows(
    app: &AppHandle,
    title: &str,
    rows: &[&CommandSpec],
) -> Result<Submenu<Wry>, String> {
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    push_rows(app, &mut items, rows)?;
    submenu(app, title, items)
}

/// Appends the rows, with a separator wherever the section changes.
fn push_rows(
    app: &AppHandle,
    items: &mut Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>,
    rows: &[&CommandSpec],
) -> Result<(), String> {
    let mut previous: Option<u32> = None;
    for spec in rows {
        let section = spec.section.unwrap_or(0);
        if previous.is_some_and(|last| last != section) {
            items.push(Box::new(
                PredefinedMenuItem::separator(app).map_err(to_message)?,
            ));
        }
        previous = Some(section);
        items.push(Box::new(
            MenuItem::with_id(
                app,
                &spec.id,
                &spec.title,
                true,
                spec.accelerator.as_deref(),
            )
            .map_err(to_message)?,
        ));
    }
    Ok(())
}

fn main() {
    // Launch budget instrument (docs/performance.md § Launch): `main` → the WebView
    // reports the page loaded. Process start → `main` is dyld work this cannot see;
    // the JS side logs navigation → first frame separately.
    let launched_at = Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!(
                    target: "app",
                    "window loaded {} ms after main",
                    launched_at.elapsed().as_millis()
                );
            }
        })
        .on_menu_event(|app, event| {
            // The id, and nothing else. What it means is the client's business.
            let _ = app.emit(COMMAND_EVENT, event.id().0.clone());
        })
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            bridge_connect,
            bridge_receive,
            bridge_send,
            bridge_close,
            install_menu,
            launch_agent_status,
            register_launch_agent,
            unregister_launch_agent,
            open_login_items_settings,
            stop_background_service,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Janela shell");
}
