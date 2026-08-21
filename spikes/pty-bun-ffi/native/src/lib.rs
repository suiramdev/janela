//! Spike: prove a Rust cdylib behind `bun:ffi` can host Janela's PTY layer.
//!
//! Proves, specifically:
//!   * openpty + fork + login_tty + execve, so the child gets a *controlling*
//!     terminal (job control, /dev/tty, full-screen TUIs).
//!   * argv is a real array end to end. No shell, no re-parse, no quoting bugs.
//!   * a reader thread with high/low water marks: past the high mark we stop
//!     reading, the kernel PTY buffer fills, and the child blocks in write(2).
//!     Bytes are never dropped.
//!   * one drain call per frame moves megabytes, so JS makes ~125 FFI calls a
//!     second regardless of throughput.

use libc::{c_char, c_int, c_void};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex};

const HIGH_WATER: usize = 4 * 1024 * 1024;
const LOW_WATER: usize = 1 * 1024 * 1024;
const READ_SIZE: usize = 128 * 1024;

struct Ring {
    data: VecDeque<u8>,
    closed: bool,
}

struct Pty {
    master: c_int,
    pid: libc::pid_t,
    ring: Arc<(Mutex<Ring>, Condvar)>,
    exit_code: Arc<AtomicI32>,
    reaped: Arc<AtomicBool>,
}

static mut TABLE: Option<Mutex<Vec<Option<Box<Pty>>>>> = None;
static INIT: std::sync::Once = std::sync::Once::new();

fn table() -> &'static Mutex<Vec<Option<Box<Pty>>>> {
    unsafe {
        INIT.call_once(|| {
            TABLE = Some(Mutex::new(Vec::new()));
        });
        #[allow(static_mut_refs)]
        TABLE.as_ref().unwrap()
    }
}

/// Spawn a child on a fresh PTY.
///
/// `argv` and `envp` are NULL-terminated arrays of C strings, exactly as
/// `execve` wants them. Nothing here parses a command line.
#[no_mangle]
pub extern "C" fn jpty_spawn(
    path: *const c_char,
    argv: *const *const c_char,
    envp: *const *const c_char,
    cwd: *const c_char,
    cols: u16,
    rows: u16,
    out_pid: *mut i32,
) -> i32 {
    let mut master: c_int = -1;
    let mut replica: c_int = -1;
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    unsafe {
        if libc::openpty(
            &mut master,
            &mut replica,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &ws as *const libc::winsize as *mut libc::winsize,
        ) != 0
        {
            return -(errno());
        }

        let pid = libc::fork();
        if pid < 0 {
            let e = errno();
            libc::close(master);
            libc::close(replica);
            return -e;
        }

        if pid == 0 {
            // ---- child: async-signal-safe calls only, nothing pre-marshalled here.
            libc::close(master);
            // login_tty: setsid + TIOCSCTTY + dup2 onto 0/1/2. This is the step
            // neither Foundation.Process nor posix_spawn can do on Darwin.
            if libc::login_tty(replica) != 0 {
                libc::_exit(126);
            }
            if !cwd.is_null() {
                libc::chdir(cwd);
            }
            // Restore default dispositions: a JS runtime ignores SIGPIPE, and an
            // inherited ignore breaks every well-behaved CLI.
            for sig in [libc::SIGPIPE, libc::SIGINT, libc::SIGQUIT, libc::SIGTERM] {
                libc::signal(sig, libc::SIG_DFL);
            }
            libc::execve(path, argv, envp);
            libc::_exit(127);
        }

        // ---- parent
        libc::close(replica);
        if !out_pid.is_null() {
            *out_pid = pid as i32;
        }

        let ring = Arc::new((
            Mutex::new(Ring {
                data: VecDeque::with_capacity(READ_SIZE),
                closed: false,
            }),
            Condvar::new(),
        ));
        let exit_code = Arc::new(AtomicI32::new(i32::MIN));
        let reaped = Arc::new(AtomicBool::new(false));

        // Reader thread. Blocking reads, so no polling and no JS thread involved.
        {
            let ring = ring.clone();
            let exit_code = exit_code.clone();
            let reaped = reaped.clone();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; READ_SIZE];
                loop {
                    // Back-pressure: past the high mark, stop reading. The kernel
                    // PTY buffer fills and the child blocks in write(2). We never
                    // drop a byte, because a dropped byte truncates an escape
                    // sequence and desynchronises the parser forever.
                    {
                        let (lock, cv) = &*ring;
                        let mut guard = lock.lock().unwrap();
                        while guard.data.len() >= HIGH_WATER && !guard.closed {
                            guard = cv.wait(guard).unwrap();
                        }
                        if guard.closed {
                            break;
                        }
                    }
                    let n = unsafe {
                        libc::read(master, buf.as_mut_ptr() as *mut c_void, READ_SIZE)
                    };
                    if n > 0 {
                        let (lock, _) = &*ring;
                        let mut guard = lock.lock().unwrap();
                        guard.data.extend(&buf[..n as usize]);
                    } else if n == 0 || unsafe { errno_raw() } != libc::EINTR {
                        break;
                    }
                }
                let (lock, _) = &*ring;
                lock.lock().unwrap().closed = true;
                let mut status: c_int = 0;
                unsafe { libc::waitpid(pid, &mut status, 0) };
                let code = if libc::WIFEXITED(status) {
                    libc::WEXITSTATUS(status)
                } else if libc::WIFSIGNALED(status) {
                    128 + libc::WTERMSIG(status)
                } else {
                    -1
                };
                // Rule: the fd is closed by the thread that reads it, never by
                // another thread while a read is pending. Closing it from the
                // outside blocks the caller indefinitely on Darwin — measured.
                unsafe { libc::close(master) };
                exit_code.store(code, Ordering::SeqCst);
                reaped.store(true, Ordering::SeqCst);
            });
        }

        let pty = Box::new(Pty {
            master,
            pid,
            ring,
            exit_code,
            reaped,
        });
        let mut t = table().lock().unwrap();
        t.push(Some(pty));
        (t.len() - 1) as i32
    }
}

/// Drain up to `len` bytes. Returns bytes written, 0 when empty, -1 when the
/// child is gone and the ring is drained.
#[no_mangle]
pub extern "C" fn jpty_read(handle: i32, out: *mut u8, len: usize) -> isize {
    let t = table().lock().unwrap();
    let Some(Some(pty)) = t.get(handle as usize) else {
        return -2;
    };
    let (lock, cv) = &*pty.ring;
    let mut guard = lock.lock().unwrap();
    let was_over = guard.data.len() >= HIGH_WATER;
    let n = guard.data.len().min(len);
    if n == 0 {
        return if guard.closed { -1 } else { 0 };
    }
    let dst = unsafe { std::slice::from_raw_parts_mut(out, n) };
    for (i, b) in guard.data.drain(..n).enumerate() {
        dst[i] = b;
    }
    // Resume reading once we are back under the low mark.
    if was_over && guard.data.len() <= LOW_WATER {
        cv.notify_all();
    }
    n as isize
}

#[no_mangle]
pub extern "C" fn jpty_write(handle: i32, data: *const u8, len: usize) -> isize {
    let t = table().lock().unwrap();
    let Some(Some(pty)) = t.get(handle as usize) else {
        return -2;
    };
    unsafe { libc::write(pty.master, data as *const c_void, len) }
}

#[no_mangle]
pub extern "C" fn jpty_resize(handle: i32, cols: u16, rows: u16, xpix: u16, ypix: u16) -> i32 {
    let t = table().lock().unwrap();
    let Some(Some(pty)) = t.get(handle as usize) else {
        return -2;
    };
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: xpix,
        ws_ypixel: ypix,
    };
    unsafe {
        if libc::ioctl(pty.master, libc::TIOCSWINSZ, &ws) != 0 {
            return -(errno());
        }
    }
    0
}

/// Signal the child's *process group*, which is what Ctrl-C does. Signalling
/// only the direct child leaves grandchildren orphaned and running.
#[no_mangle]
pub extern "C" fn jpty_signal(handle: i32, sig: i32) -> i32 {
    let t = table().lock().unwrap();
    let Some(Some(pty)) = t.get(handle as usize) else {
        return -2;
    };
    unsafe {
        if libc::killpg(pty.pid, sig) != 0 {
            return -(errno());
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn jpty_exit_code(handle: i32) -> i32 {
    let t = table().lock().unwrap();
    let Some(Some(pty)) = t.get(handle as usize) else {
        return i32::MIN;
    };
    if pty.reaped.load(Ordering::SeqCst) {
        pty.exit_code.load(Ordering::SeqCst)
    } else {
        i32::MIN
    }
}

/// Hang up: SIGHUP the process group and let the reader thread wind itself down.
///
/// Never blocks, and never closes the master fd from this thread. Closing an fd
/// that another thread is blocked reading hangs the caller on Darwin, which is
/// why the reader thread owns the close.
#[no_mangle]
pub extern "C" fn jpty_close(handle: i32) {
    let mut t = table().lock().unwrap();
    if let Some(slot) = t.get_mut(handle as usize) {
        if let Some(pty) = slot.take() {
            unsafe { libc::killpg(pty.pid, libc::SIGHUP) };
            let (lock, cv) = &*pty.ring;
            lock.lock().unwrap().closed = true;
            cv.notify_all();
            // `pty` is dropped here; the reader thread holds its own Arc to the
            // ring and closes `master` when its read returns.
            std::mem::forget(pty);
        }
    }
}

fn errno() -> i32 {
    unsafe { errno_raw() }
}

unsafe fn errno_raw() -> i32 {
    *libc::__error()
}
