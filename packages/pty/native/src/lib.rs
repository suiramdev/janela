//! Janela's PTY layer: `openpty` + `fork` + `login_tty` + `execve`, a reader
//! thread with high/low water marks, and nothing else.
//!
//! ## Why this is Rust and not TypeScript
//!
//! A child process needs a *controlling* terminal or job control breaks: Ctrl-C
//! delivers no SIGINT, `tcsetpgrp` fails, and every full-screen TUI misbehaves.
//! On Darwin, `TIOCSCTTY` must be issued by the child after `setsid()`, which
//! means it must happen between `fork` and `execve` — and in that window the child
//! may call only async-signal-safe functions. A JavaScript runtime returning from
//! an FFI call into its own scheduler is the opposite of that. So the whole
//! fork/exec sequence has to be one native call.
//!
//! ## Rules this file enforces
//!
//! 1. **argv is an array, end to end.** Nothing here parses a command line, so the
//!    quoting bug class does not exist. This is the same rule
//!    `LaunchProfile.command` and `AutomationCommand.command` follow.
//! 2. **Bytes are never dropped.** Past `HIGH_WATER` the reader stops reading; the
//!    kernel PTY buffer fills and the child blocks in `write(2)`, exactly as
//!    against a slow physical terminal. Reading resumes at `LOW_WATER`. Dropping a
//!    byte would truncate an escape sequence and desynchronise the parser, which
//!    is a corruption with a delay rather than a lost line.
//! 3. **The descriptor is closed by the thread that reads it.** Closing it from
//!    another thread while a read is pending blocks that thread indefinitely on
//!    Darwin — measured, not theorised.
//! 4. **`jpty_signal` targets the process group.** Signalling only the direct
//!    child leaves grandchildren orphaned. Note that Ctrl-C is *not* this: the
//!    caller writes `0x03` and lets the line discipline pick the foreground group.
//!
//! See docs/decisions/0021-pty-native-layer.md.

// TODO: Implement the FFI surface below. The migration spike
// (spikes/pty-bun-ffi/) is a working reference implementation of exactly these
// functions — it sustained 132 MB/s under a `yes` flood with bounded memory, ran
// vim on the alternate screen, delivered SIGWINCH, reported exit codes including
// signal deaths, and torn down without hanging. Port it, then add:
//
//   - `ws_xpixel`/`ws_ypixel` on resize, for sixel and SGR-pixel mouse mode.
//   - A guard on the handle table so a stale handle is an error rather than a
//     panic across the FFI boundary. A panic here unwinds into the JavaScript
//     runtime, which is why the release profile sets `panic = "abort"`.
//   - `jpty_drop_all`, for the daemon's SIGTERM path: hang up every PTY before
//     exiting so children get SIGHUP rather than being reparented onto launchd.

/// Stop reading once this much undelivered output is buffered.
const _HIGH_WATER: usize = 4 * 1024 * 1024;
/// Resume reading once the backlog drops back to this.
const _LOW_WATER: usize = 1024 * 1024;
/// Per-read request size. Large enough that a flood is a handful of syscalls.
const _READ_SIZE: usize = 128 * 1024;
