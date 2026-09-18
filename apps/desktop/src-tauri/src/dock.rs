//! The Dock icon, following the theme.
//!
//! A bundle carries one icon, and the light and dark tiles differ in more than
//! their tint — the surface, the border and the ink all swap — so an icon that
//! matched the dark window would sit wrong beside a light one. `tao` makes a
//! window icon a no-op on macOS and Tauri has no Dock API, so this is AppKit's
//! `applicationIconImage` directly: the process-wide icon the Dock draws for as
//! long as the app runs, with the bundle's own icon back the moment it quits.
//!
//! The client decides which of the two it wants and says so per *effective*
//! appearance, not per theme preference: under System the window follows macOS,
//! and the WebView's `prefers-color-scheme` is the one place that knows what it
//! resolved to. The shell only decodes and sets.
//!
//! The two PNGs are the 512 px tiles from `icons/`, embedded so the icon cannot
//! drift from the ones the bundle ships. AppKit decodes them; nothing here pulls
//! an image crate in for two files.

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use serde::Deserialize;
use tauri::AppHandle;

const DARK_ICON: &[u8] = include_bytes!("../icons/512x512.png");
const LIGHT_ICON: &[u8] = include_bytes!("../icons/512x512-light.png");

/// Which of the two tiles the window resolved to.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DockAppearance {
    Light,
    Dark,
}

impl DockAppearance {
    fn icon(self) -> &'static [u8] {
        match self {
            DockAppearance::Light => LIGHT_ICON,
            DockAppearance::Dark => DARK_ICON,
        }
    }
}

/// Swaps the Dock icon for the tile that matches `appearance`. A tile AppKit
/// cannot decode is logged and the Dock keeps what it had: an icon is never
/// worth an error in the window.
#[tauri::command]
pub fn set_dock_icon(app: AppHandle, appearance: DockAppearance) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };

        let data = NSData::with_bytes(appearance.icon());
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
            log::warn!(target: "shell", "dock icon for {appearance:?} did not decode");
            return;
        };

        // SAFETY: called on the main thread, which `mtm` proves, with an image
        // AppKit just decoded and owns for the length of the call.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_tiles_decode_as_512_px_images() {
        for appearance in [DockAppearance::Light, DockAppearance::Dark] {
            let data = NSData::with_bytes(appearance.icon());
            let image = NSImage::initWithData(NSImage::alloc(), &data)
                .unwrap_or_else(|| panic!("{appearance:?} tile did not decode"));
            let size = image.size();

            assert_eq!((size.width, size.height), (512.0, 512.0), "{appearance:?}");
        }
    }
}
