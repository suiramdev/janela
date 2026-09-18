//! The notification sound.
//!
//! A macOS notification carries no sound unless it names one, and what it can name
//! is a *sound resource* — a file in `/System/Library/Sounds`, `~/Library/Sounds`
//! or the bundle. A file the user picked from anywhere else on their disk is not
//! one of those, so a sound of the user's own could never travel on the
//! notification. Janela therefore plays every sound itself, through `NSSound`, and
//! the notification stays silent: one mechanism for both halves of the setting,
//! and the sound still arrives when macOS has refused the banner.
//!
//! Two things about `NSSound` are load-bearing here, and both were measured rather
//! than assumed:
//!
//!   * **A named sound is a shared, cached instance, and it stays `isPlaying`
//!     after it has finished.** A second `play` on it answers `false` and makes no
//!     sound at all, which would have made every notification after the first one
//!     silent. `stop` first, and it plays again.
//!   * **A playing sound needs an owner.** A file-backed `NSSound` has no other
//!     one, and releasing it while it plays can cut it off. `PLAYING` is that
//!     owner, and it holds exactly **one** sound — the last one asked for — so a
//!     day of notifications cannot accumulate audio (AGENTS.md
//!     § Non-negotiables 9).
//!
//! `NSSound` needs no main-thread marker in AppKit's own annotations, and Tauri
//! answers a synchronous command on the thread the IPC call arrived on, so nothing
//! here dispatches.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_app_kit::NSSound;
use objc2_foundation::NSString;

thread_local! {
    static PLAYING: RefCell<Option<Retained<NSSound>>> = const { RefCell::new(None) };
}

/// The sound the client asked for.
///
/// `silent` never crosses: a client that wants no sound plays none rather than
/// asking for nothing, so the shell is only ever handed a sound to make. Paired
/// with `NotificationSound` in `@janela/client`.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SoundChoice {
    /// One of macOS's own alert sounds, by the name its Sound pane shows.
    System { name: String },
    /// Any audio file macOS can play, at a path the user chose themselves.
    Custom { path: String },
}

/// Plays the chosen sound, replacing whatever was playing.
///
/// A name macOS cannot resolve or a file it cannot read is an error the client
/// logs and drops: a sound that failed to play must not cost the user their
/// notification, let alone their terminal output.
#[tauri::command]
pub fn play_notification_sound(sound: SoundChoice) -> Result<(), String> {
    let resolved = match &sound {
        SoundChoice::System { name } => NSSound::soundNamed(&NSString::from_str(name))
            .ok_or_else(|| format!("no system sound named {name}")),
        SoundChoice::Custom { path } => NSSound::initWithContentsOfFile_byReference(
            NSSound::alloc(),
            &NSString::from_str(path),
            true,
        )
        .ok_or_else(|| "unreadable sound file".to_owned()),
    }?;

    if resolved.isPlaying() {
        resolved.stop();
    }

    let played = resolved.play();

    PLAYING.with_borrow_mut(|holder| {
        holder.replace(resolved);
    });

    if played {
        Ok(())
    } else {
        Err("the sound refused to play".to_owned())
    }
}
