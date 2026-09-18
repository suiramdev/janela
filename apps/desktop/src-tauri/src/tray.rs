//! The menu bar's status item — the daemon's face when no window is in front of
//! you.
//!
//! ## Why the daemon needs a surface here
//!
//! Terminals live in `janelad`, so quitting Janela is cheap and leaves the user
//! with nothing on screen that says their work is still running. The status item
//! is the honest consequence of that design: somewhere to bring the window back,
//! somewhere to quit knowing the terminals stay, and somewhere to stop the daemon
//! on purpose — which is the one action that ends them (AGENTS.md
//! non-negotiable 7, and the reason that row asks the window to state the cost
//! rather than deciding anything here).
//!
//! ## Two phases, and why
//!
//! `install` runs during setup with the two rows the shell answers itself, Show
//! and Quit, because those are exactly what a user reaches for when the WebView
//! is slow, blank or wedged — a status item that only appears once the page has
//! loaded would be missing when it is most wanted. `set_commands` then replaces
//! the menu with those two plus every row `COMMANDS` marks for the tray, so the
//! titles come from the same table the menu bar and the palette read and the
//! shell still knows nothing about what a row means.
//!
//! Tray rows are built **without their accelerator**, and a row that also sits in
//! the menu bar — `stopDaemon` is in both — keeps its chord there. Either way a
//! chord on this copy is wrong: dead, because a status item's menu is not the main
//! menu bar, or a second AppKit registration of a chord the bar already owns, which
//! is how one ⌘D came to split twice (see `install_menu`). The bar's copy is the one
//! `set_menu_accelerators` edits.
//!
//! ## The glyph is drawn, not shipped
//!
//! A status item wants a template image: an alpha mask macOS tints itself, which
//! is what makes one asset correct in a light menu bar, a dark one and under
//! increased contrast. The app icon is the wrong shape for that — a tinted
//! phosphor field on an opaque tile, which is mud at 18 pt and has no alpha to
//! tint — and decoding a PNG instead would add the `image` crate to the shell for
//! 1,296 pixels. So the mark is the icon's hand as a 36-row text bitmap with
//! four coverage levels, decoded once per launch, off the
//! terminal path, and owning no asset that can drift from the icons beside it.

use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::CommandSpec;

/// The status item, the row the shell answers itself, and the namespace its copies
/// of the table's rows live in.
///
/// All three use a scheme no `CommandID` can spell, so `on_menu_event` can tell a
/// status-item click from the same command chosen in the menu bar — which is the
/// difference between needing the window raised first and already looking at it.
pub const TRAY_ID: &str = "janela://tray";
pub const SHOW_ID: &str = "janela://tray/show";
const ROW_PREFIX: &str = "janela://tray/row/";

/// What the item says on hover: the one fact it exists to carry.
const TOOLTIP: &str = "Janela — your terminals keep running";

/// The command a status-item row carries, or `None` for any other menu item.
pub fn row_command(id: &str) -> Option<&str> {
    id.strip_prefix(ROW_PREFIX)
}

/// Adds the item, with the two rows that must not wait for a page load.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let menu = tray_menu(app, &[])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(glyph())
        .icon_as_template(true)
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)
        .map(|_tray| ())
        .map_err(to_message)
}

/// Replaces the menu with the table's tray rows between Show and Quit.
///
/// A missing status item is not a fault: the user may have removed it, and the
/// window is unaffected either way.
pub fn set_commands(app: &AppHandle, rows: &[&CommandSpec]) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    tray.set_menu(Some(tray_menu(app, rows)?))
        .map_err(to_message)
}

/// Brings the app back: unhidden, unminimised, in front.
///
/// Every step is attempted, and a failure in one does not stop the next — the
/// window may be in any of those states, and the point of the row is that it ends
/// with Janela visible.
pub fn show(app: &AppHandle) {
    let _ = app.show();

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn tray_menu(app: &AppHandle, rows: &[&CommandSpec]) -> Result<Menu<Wry>, String> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![Box::new(
        MenuItem::with_id(app, SHOW_ID, "Show Janela", true, None::<&str>).map_err(to_message)?,
    )];

    if !rows.is_empty() {
        items.push(Box::new(
            PredefinedMenuItem::separator(app).map_err(to_message)?,
        ));
    }

    for spec in rows {
        let id = format!("{ROW_PREFIX}{}", spec.id);

        items.push(Box::new(
            MenuItem::with_id(app, id, &spec.title, true, None::<&str>).map_err(to_message)?,
        ));
    }

    items.push(Box::new(
        PredefinedMenuItem::separator(app).map_err(to_message)?,
    ));
    items.push(Box::new(
        PredefinedMenuItem::quit(app, Some("Quit Janela")).map_err(to_message)?,
    ));

    let references: Vec<&dyn IsMenuItem<Wry>> =
        items.iter().map(std::convert::AsRef::as_ref).collect();

    Menu::with_items(app, &references).map_err(to_message)
}

fn to_message(error: tauri::Error) -> String {
    error.to_string()
}

/// The mark's grid, in pixels.
///
/// 36 px tall because `tray-icon` scales whatever it is given to 18 pt: exactly
/// two device pixels per point on every Mac that runs this app.
const GLYPH_SIZE: u32 = 36;

/// Coverage per pixel, one character each: space is clear, `.` a third, `+` two
/// thirds, `#` solid. The silhouette is the app icon's hand at 32 px wide.
const GLYPH_ROWS: [&str; 36] = [
    "                                    ",
    "                                    ",
    "                                    ",
    "                                    ",
    "                                    ",
    "               ++###+.              ",
    "             .#########.            ",
    "             ###########            ",
    "            +###########.           ",
    "            ############.           ",
    "           +############+           ",
    "          +##############.          ",
    "         +################          ",
    "       .+#################+         ",
    "      .####################+        ",
    "     .######################+       ",
    "    .#########################+     ",
    "   .###############+############.   ",
    "  .############++.   ###########+   ",
    "  #####+..####+      +###########   ",
    "  #####   +###+      +###++######+  ",
    "  .####   +###.      +###..#######  ",
    "  .###+   +###.      +###..### ###  ",
    "  .###.   +###.      #### .### ##+  ",
    "  .##.    +###+     .###+ +##+ ##+  ",
    "          .###+     +###. ###. +#.  ",
    "           ###+     +### +###   .   ",
    "           .##      .##+ ###.       ",
    "                     ++  ##+        ",
    "                         +#.        ",
    "                                    ",
    "                                    ",
    "                                    ",
    "                                    ",
    "                                    ",
    "                                    ",
];

fn glyph() -> Image<'static> {
    let side = GLYPH_SIZE as usize;
    let mut rgba = vec![0u8; side * side * 4];

    for (y, row) in GLYPH_ROWS.iter().enumerate() {
        for (x, cell) in row.bytes().enumerate().take(side) {
            rgba[(y * side + x) * 4 + 3] = coverage(cell);
        }
    }

    Image::new_owned(rgba, GLYPH_SIZE, GLYPH_SIZE)
}

/// The alpha a row character stands for; anything unexpected is clear.
fn coverage(cell: u8) -> u8 {
    match cell {
        b'.' => 85,
        b'+' => 170,
        b'#' => 255,
        _ => 0,
    }
}
