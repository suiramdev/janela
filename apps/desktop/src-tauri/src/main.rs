//! Janela's Tauri shell.
//!
//! Deliberately thin, and the list of what belongs here is closed:
//!
//!   * the window, and its native chrome
//!   * the native menu bar and its accelerators, and the status item beside the
//!     clock — the daemon's surface when no window is in front of you
//!   * native notifications, and the sound one plays — `sound.rs`, because the
//!     sound a user chose from their own disk is not a name a notification can
//!     carry
//!   * the native directory picker — **the app performs file selection; the daemon
//!     is handed paths.** That is a rule, not a convenience: it is what keeps macOS
//!     permission prompts attributed to the app the user just clicked rather than to
//!     a background binary they have never heard of. Confirmations are *not* native:
//!     a question about a terminal in this window is asked in it, which is why the
//!     capability is `dialog:allow-open` rather than `dialog:default`.
//!   * the daemon sidecar's lifecycle and launch-agent registration
//!   * **the Unix-socket bridge**, because a WebView cannot open a socket
//!
//! What does not belong here: anything about projects, sessions, terminals or the
//! protocol's meaning. This shell relays frames; it does not read them. If Rust code
//! here starts needing to know what a `StateUpdate` is, the boundary has moved and
//! the reason belongs in `docs/architecture.md`.

// The native menu is built at runtime from `@janela/ui`'s `COMMANDS`, which the
// frontend sends once at startup (`install_menu` below). The shell reads ids,
// titles, accelerators, which menu a row goes in and whether it also belongs in
// the status item — and nothing else. It does not know what any command *means*,
// which is what stops the menu bar and the in-app command palette drifting apart:
// there is one table, in TypeScript, and adding a row to it needs no Rust change.
// A user's own shortcuts arrive later, through `set_menu_accelerators`, and are
// applied to the items already in the bar — never by building a second menu (see
// `install_menu`).
//
// The status item is `tray.rs`: Show and Quit, which the shell answers itself and
// which therefore exist from launch rather than from page load, around the table's
// tray rows. Stopping the daemon is one of those rows precisely because the shell
// must not decide it — the cost is counted in sessions and live terminals, which
// only the client knows.

// The socket bridge is `bridge.rs`: it relays length-prefixed frames as raw bytes
// in both directions and applies the two back-pressure policies — coalesced
// repaints may drop their oldest, control frames and input may not. Getting that
// wrong shows up as a terminal that is subtly corrupt after a stall.
//
// Launch-agent registration is `agent.rs`: `SMAppService.agent(plistName:)` over
// the plist sealed into `Contents/Library/LaunchAgents`, with
// `launchctl kickstart` standing in for socket activation. The sidecar is a single
// compiled Bun binary at `Contents/MacOS/janelad`, which is what keeps the signing
// story at two binaries rather than three. Neither module reads a frame's meaning,
// and neither writes a plist.

mod agent;
mod bridge;
mod dock;
mod sound;
mod tray;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use agent::{
    launch_agent_status, open_login_items_settings, register_launch_agent, stop_background_service,
    unregister_launch_agent,
};
use bridge::{bridge_close, bridge_connect, bridge_receive, bridge_send, BridgeState};
use sound::play_notification_sound;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, State, Wry};

/// The event a chosen menu item arrives on.
///
/// Paired with `COMMAND_EVENT` in `apps/desktop/src/adapters/menu.ts`; the two spellings
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
    #[serde(default)]
    tray: bool,
}

/// One row of the user's shortcut table, as it crosses from the WebView: the chord
/// a command now has, or `None` for a command with no chord at all.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceleratorSpec {
    id: String,
    accelerator: Option<String>,
}

/// The menu bar's mutable half.
///
/// `items` is every command row in the bar, by id, so a later accelerator change
/// can be applied to the item that is already there. `accelerators` is the last
/// table the WebView sent, kept so that a table arriving *before* the menu is
/// built (settings load and the menu install are two independent promises) is
/// honoured when it is.
#[derive(Default)]
struct MenuState {
    items: Mutex<Option<HashMap<String, MenuItem<Wry>>>>,
    accelerators: Mutex<HashMap<String, Option<String>>>,
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
/// every hot reload, which is how this was found. What *does* change at runtime
/// is a row's accelerator, and that is edited on the existing item.
#[tauri::command]
fn install_menu(
    app: AppHandle,
    state: State<'_, MenuState>,
    commands: Vec<CommandSpec>,
) -> Result<(), String> {
    let mut installed = lock(&state.items);
    if installed.is_some() {
        return Ok(());
    }

    let overrides = lock(&state.accelerators);
    let commands: Vec<CommandSpec> = commands
        .into_iter()
        .map(|spec| match overrides.get(&spec.id) {
            Some(accelerator) => CommandSpec {
                accelerator: accelerator.clone(),
                ..spec
            },
            None => spec,
        })
        .collect();
    drop(overrides);

    let rows = |menu: &str| -> Vec<&CommandSpec> {
        commands.iter().filter(|spec| spec.menu == menu).collect()
    };
    let mut items: HashMap<String, MenuItem<Wry>> = HashMap::new();

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
    push_rows(&app, &mut app_items, &rows("app"), &mut items)?;
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

    let file = submenu_of_rows(&app, "File", &rows("file"), &mut items)?;

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

    let view = submenu_of_rows(&app, "View", &rows("view"), &mut items)?;
    let session = submenu_of_rows(&app, "Session", &rows("session"), &mut items)?;
    let terminal = submenu_of_rows(&app, "Terminal", &rows("terminal"), &mut items)?;

    // No Close Window: ⌘W closes a *pane*, and a window holding a running agent is
    // not something to close by reflex. No Enter Full Screen either — its default
    // chord is ⌃⌘F, and `Ctrl` belongs to the terminal.
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

    // The status item reads the same table, and is the one menu the shell rebuilds:
    // it is not the main menu bar, and its rows carry no accelerator, so replacing
    // it registers nothing with AppKit that the bar has already claimed.
    let tray_rows: Vec<&CommandSpec> = commands.iter().filter(|spec| spec.tray).collect();
    tray::set_commands(&app, &tray_rows)?;
    *installed = Some(items);
    Ok(())
}

/// Replaces every command row's accelerator with the user's table.
///
/// Applied in place on the items `install_menu` kept, so AppKit sees one key
/// equivalent per chord throughout. Before the menu exists the table is only
/// remembered; `install_menu` reads it. An unknown id is skipped rather than an
/// error: the table is the WebView's, and a row the bar has no item for (a
/// command hidden on this client) is not a fault.
#[tauri::command]
fn set_menu_accelerators(
    state: State<'_, MenuState>,
    accelerators: Vec<AcceleratorSpec>,
) -> Result<(), String> {
    let mut remembered = lock(&state.accelerators);
    remembered.clear();
    for spec in &accelerators {
        remembered.insert(spec.id.clone(), spec.accelerator.clone());
    }
    drop(remembered);

    let installed = lock(&state.items);
    let Some(items) = installed.as_ref() else {
        return Ok(());
    };
    for spec in &accelerators {
        if let Some(item) = items.get(&spec.id) {
            item.set_accelerator(spec.accelerator.as_deref())
                .map_err(to_message)?;
        }
    }
    Ok(())
}

/// A poisoned menu lock means a panic mid-edit of the menu bar; the bar is still
/// AppKit's and still usable, so carry on with whatever state was left.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    by_id: &mut HashMap<String, MenuItem<Wry>>,
) -> Result<Submenu<Wry>, String> {
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    push_rows(app, &mut items, rows, by_id)?;
    submenu(app, title, items)
}

/// Appends the rows, with a separator wherever the section changes, and records
/// each item by id so its accelerator can be edited later.
fn push_rows(
    app: &AppHandle,
    items: &mut Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>,
    rows: &[&CommandSpec],
    by_id: &mut HashMap<String, MenuItem<Wry>>,
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
        let item = MenuItem::with_id(
            app,
            &spec.id,
            &spec.title,
            true,
            spec.accelerator.as_deref(),
        )
        .map_err(to_message)?;
        by_id.insert(spec.id.clone(), item.clone());
        items.push(Box::new(item));
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
        .setup(|app| {
            // A status item that cannot be created is not a reason to refuse the
            // window: the menu bar's extras are the user's to remove.
            if let Err(message) = tray::install(app.handle()) {
                log::error!(target: "app", "status item unavailable: {message}");
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();

            // Show is the shell's own row, and the window is the shell's to raise:
            // the WebView cannot raise itself.
            if id == tray::SHOW_ID {
                tray::show(app);

                return;
            }

            // A row chosen from the status item is still answered in the window —
            // stopping the daemon states its cost in sessions and live terminals
            // there — so the window comes forward before the id goes over.
            let command = match tray::row_command(id) {
                Some(command) => {
                    tray::show(app);

                    command
                }
                None => id,
            };

            // The id, and nothing else. What it means is the client's business.
            let _ = app.emit(COMMAND_EVENT, command.to_owned());
        })
        .manage(BridgeState::default())
        .manage(MenuState::default())
        .invoke_handler(tauri::generate_handler![
            bridge_connect,
            bridge_receive,
            bridge_send,
            bridge_close,
            install_menu,
            set_menu_accelerators,
            launch_agent_status,
            register_launch_agent,
            unregister_launch_agent,
            open_login_items_settings,
            stop_background_service,
            dock::set_dock_icon,
            play_notification_sound,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Janela shell");
}
