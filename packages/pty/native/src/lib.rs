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
//! ## The two windows where the rules above are not enough
//!
//! **Between `fork` and `execve`** the child may not allocate, may not take a
//! lock, and may not panic: `fork` in a multi-threaded process keeps only the
//! calling thread, so any lock another Bun thread held — the allocator's above all
//! — stays held forever. Everything in `child_exec` is a syscall on values the
//! parent prepared.
//!
//! **Across the FFI boundary** a panic is undefined behaviour, which is why the
//! release profile sets `panic = "abort"`. Every handle lookup here returns an
//! `Option`, no `unwrap` appears, and a poisoned mutex is recovered rather than
//! propagated, so the abort is a backstop and not a mechanism.
//!
//! See docs/decisions/0021-pty-native-layer.md.

// An `unsafe fn` does not get a free pass on its own body. Three of the exports
// below take raw pointers the caller has to keep valid, so their signatures say
// `unsafe` — and this keeps every dereference inside a block that a reviewer can
// see, rather than making the whole function one implicit unsafe region. In the
// one file whose fault takes every terminal the user has, that is the trade to
// make.
#![deny(unsafe_op_in_unsafe_fn)]

use libc::{c_char, c_int, c_void, pid_t};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

/// Stop reading once this much undelivered output is buffered.
const HIGH_WATER: usize = 4 * 1024 * 1024;
/// Resume reading once the backlog drops back to this.
const LOW_WATER: usize = 1024 * 1024;
/// Per-read request size. Large enough that a flood is a handful of syscalls.
const READ_SIZE: usize = 128 * 1024;

/// The ring never grows past this. The reader tests `HIGH_WATER` *before* a read,
/// so it can overshoot the mark by at most one `READ_SIZE`, and that overshoot is
/// the whole of the difference. Non-negotiable #9 wants the bound structural
/// rather than asserted, and this is it: there is no code path that allocates a
/// larger ring.
const RING_CAPACITY_CEILING: usize = HIGH_WATER + READ_SIZE;

/// Concurrent terminals, which is also the width of the handle's index field.
/// The scale target is 40 open and 8 live, so this is two orders of magnitude of
/// headroom, and it bounds the table at roughly 64 KB for the daemon's lifetime.
const MAX_TERMINALS: usize = 1 << INDEX_BITS;
const INDEX_BITS: u32 = 12;
const INDEX_MASK: i32 = (1 << INDEX_BITS) - 1;
/// Reuses of one slot index before the generation wraps. 19 bits leaves the sign
/// bit of the handle clear, which is what keeps a handle out of the `-errno` band.
const GENERATION_BITS: u32 = 19;
const MAX_GENERATION: u32 = (1 << GENERATION_BITS) - 1;

/// Returned by every handle-taking export when the handle does not name a live
/// terminal. Outside both errno bands: Darwin's `ELAST` is 106, so allocation
/// failures occupy `-1..-199` and exec failures `-2001..-2199`.
const JPTY_BAD_HANDLE: i32 = -1000;
/// Added to a child-side errno so the caller can tell "couldn't open a terminal"
/// from "couldn't start your program" without a second out-parameter.
const EXEC_FAILED_BIAS: i32 = 2000;

/// Failure stages the child can report down the exec-failure pipe.
const STAGE_LOGIN_TTY: i32 = 1;
const STAGE_CHDIR: i32 = 2;
const STAGE_EXECVE: i32 = 3;

/// `__DARWIN_NSIG` from `<sys/signal.h>`. `libc` does not export `NSIG` for Apple
/// targets, and hardcoding the range is preferable to resetting a hand-picked
/// four signals and leaving `SIGHUP`, `SIGCHLD` and `SIGTSTP` inherited.
const NSIG: c_int = 32;

/// Ceiling for the child's close-every-descriptor loop.
///
/// `RLIMIT_NOFILE`'s soft limit under Bun is 1048576, so looping to it would cost
/// a second per spawn. Clamped, the loop is 65533 `close` calls and measures
/// 12.4 ms on an M4 — 8% of the 150 ms "new terminal → first prompt" budget, and
/// the only async-signal-safe option Darwin offers: there is no `closefrom`, and
/// `/dev/fd` enumeration opens a descriptor. **If the daemon ever raises
/// `RLIMIT_NOFILE` past this, descriptors above it leak into children.**
const FD_CLOSE_CEILING: c_int = 65536;

// ---------------------------------------------------------------- the ring

/// Undelivered output, as a fixed-stride ring over a `Box<[u8]>`.
///
/// A ring rather than a `VecDeque<u8>` so a drain is at most two
/// `copy_nonoverlapping` calls. At the measured 133 MB/s a byte-at-a-time drain
/// is 133 million bounds-checked writes per second on the one path
/// docs/performance.md says must not compute per byte.
struct Ring {
    buf: Box<[u8]>,
    /// Next byte to drain.
    head: usize,
    /// Next byte to fill.
    tail: usize,
    len: usize,
    capacity_ceiling: usize,
    /// The high-water gate is latched: set at `HIGH_WATER`, cleared at
    /// `LOW_WATER`. Two marks rather than one, so the child is released in long
    /// runs instead of stuttering one read at a time at the boundary.
    paused: bool,
    /// The child is reaped and nothing more will arrive. Set last, after the exit
    /// code is stored, so `jpty_read` returning `-1` implies `jpty_exit_code` has
    /// an answer.
    closed: bool,
}

impl Ring {
    fn new(capacity_ceiling: usize) -> Self {
        let initial = READ_SIZE.min(capacity_ceiling);
        Ring {
            buf: vec![0u8; initial].into_boxed_slice(),
            head: 0,
            tail: 0,
            len: 0,
            capacity_ceiling,
            paused: false,
            closed: false,
        }
    }

    /// Whether the reader should stay parked, latching the gate on the way.
    fn gate_closed(&mut self) -> bool {
        if self.len >= HIGH_WATER {
            self.paused = true;
        } else if self.paused && self.len <= LOW_WATER {
            self.paused = false;
        }
        self.paused
    }

    /// Grows towards the ceiling so that `want` bytes fit, doubling from
    /// `READ_SIZE`. Never shrinks, never exceeds the ceiling.
    fn grow_for(&mut self, want: usize) {
        let needed = self.len.saturating_add(want);
        if needed <= self.buf.len() || self.buf.len() >= self.capacity_ceiling {
            return;
        }
        let mut capacity = self.buf.len();
        while capacity < needed && capacity < self.capacity_ceiling {
            capacity = capacity.saturating_mul(2);
        }
        let capacity = capacity.min(self.capacity_ceiling);
        let mut grown = vec![0u8; capacity].into_boxed_slice();
        let (first, second) = self.readable_runs();
        let mut copied = 0;
        for run in [first, second] {
            if run.1 == 0 {
                continue;
            }
            // Both slices come from `self.buf`, both lengths are bounded by
            // `self.len`, and `grown` is at least that long.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.buf.as_ptr().add(run.0),
                    grown.as_mut_ptr().add(copied),
                    run.1,
                );
            }
            copied += run.1;
        }
        self.buf = grown;
        self.head = 0;
        self.tail = self.len;
    }

    /// `(offset, length)` for the two readable runs, the second empty when the
    /// readable region does not wrap.
    fn readable_runs(&self) -> ((usize, usize), (usize, usize)) {
        let first = self.len.min(self.buf.len() - self.head);
        ((self.head, first), (0, self.len - first))
    }

    /// The contiguous writable region at the tail, as a pointer and a length.
    ///
    /// The caller reads into it with the ring lock released. That is sound
    /// because there is exactly one writer — the owning thread — so nothing else
    /// can move `tail` or reallocate `buf`, and a concurrent drain only moves
    /// `head`, which grows this region rather than shrinking it.
    fn writable_tail(&mut self, want: usize) -> (*mut u8, usize) {
        self.grow_for(want);
        let free = self.buf.len() - self.len;
        let room = free.min(self.buf.len() - self.tail).min(want);
        // SAFETY: `tail` is always strictly less than `buf.len()`.
        (unsafe { self.buf.as_mut_ptr().add(self.tail) }, room)
    }

    fn commit(&mut self, written: usize) {
        self.tail = (self.tail + written) % self.buf.len();
        self.len += written;
    }

    /// Copies `min(self.len, capacity)` bytes out and leaves the remainder.
    ///
    /// # Safety
    ///
    /// `out` must be writable for `capacity` bytes.
    unsafe fn drain_into(&mut self, out: *mut u8, capacity: usize) -> usize {
        let taken = self.len.min(capacity);
        if taken == 0 {
            return 0;
        }
        let first = taken.min(self.buf.len() - self.head);
        // SAFETY: the caller guarantees `out` holds `capacity` bytes, `taken` is
        // at most that, and both runs are bounded by the ring's own length.
        unsafe {
            std::ptr::copy_nonoverlapping(self.buf.as_ptr().add(self.head), out, first);
            if taken > first {
                std::ptr::copy_nonoverlapping(self.buf.as_ptr(), out.add(first), taken - first);
            }
        }
        self.head = (self.head + taken) % self.buf.len();
        self.len -= taken;
        taken
    }
}

// ---------------------------------------------------------------- one terminal

struct Pty {
    /// Owned by the reader thread for its whole life. Nothing else closes it.
    master: c_int,
    /// `login_tty` also made this the child's process-group id.
    pid: pid_t,
    /// Read end polled by the reader thread, write end poked by `jpty_close`, so
    /// teardown does not depend on the child cooperating. Both are closed by
    /// `Drop`, not by the reader thread: `jpty_close` holds an `Arc` across its
    /// write, and a descriptor closed underneath it could have been reused.
    wake: [c_int; 2],
    ring: Mutex<Ring>,
    ready: Condvar,
    /// `i32::MIN` until reaped, and permanently if `waitpid` returned `ECHILD`.
    exit_code: AtomicI32,
    /// The caller has hung up. Half of the slot-retirement rendezvous.
    shutdown: AtomicBool,
    /// The reader thread has reaped and closed. The other half.
    finished: AtomicBool,
}

impl Drop for Pty {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.wake[0]);
            libc::close(self.wake[1]);
        }
    }
}

// ---------------------------------------------------------------- handle table

enum Slot {
    Occupied {
        generation: u32,
        pty: Arc<Pty>,
    },
    /// Hung up *and* reaped, so the exit code outlives the terminal. Holds no
    /// `Pty`, so the ring's bytes are gone.
    Retired {
        generation: u32,
        code: i32,
    },
    /// Never used. The birth state of an appended slot.
    Free {
        generation: u32,
    },
}

impl Slot {
    fn generation(&self) -> u32 {
        match *self {
            Slot::Occupied { generation, .. }
            | Slot::Retired { generation, .. }
            | Slot::Free { generation } => generation,
        }
    }
}

struct Table {
    slots: Vec<Slot>,
    /// Retired indices, oldest first, so a just-read exit code survives as long
    /// as possible before its slot is handed out again.
    free: VecDeque<u16>,
}

static TABLE: LazyLock<Mutex<Table>> = LazyLock::new(|| {
    Mutex::new(Table {
        slots: Vec::new(),
        free: VecDeque::new(),
    })
});

/// Lock order is always table then ring, never the reverse. Lookups clone the
/// `Arc` and release this lock before touching a ring, so the table lock is O(1)
/// on every path and one terminal's drain never serialises against another's.
fn lock_table() -> MutexGuard<'static, Table> {
    // A poisoned mutex means a panic while holding it, which `panic = "abort"`
    // makes impossible in a release build. Recovering beats propagating: this is
    // the one library whose death takes every terminal the user has.
    match TABLE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_ring(pty: &Pty) -> MutexGuard<'_, Ring> {
    match pty.ring.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn pack(index: u16, generation: u32) -> i32 {
    ((generation as i32) << INDEX_BITS) | i32::from(index)
}

/// Rejects a negative handle and a zero generation, so handle `0` is never valid
/// and a JavaScript falsy check cannot silently pass.
fn unpack(handle: i32) -> Option<(usize, u32)> {
    if handle < 0 {
        return None;
    }
    let generation = (handle >> INDEX_BITS) as u32;
    if generation == 0 {
        return None;
    }
    Some(((handle & INDEX_MASK) as usize, generation))
}

fn next_generation(previous: u32) -> u32 {
    if previous >= MAX_GENERATION {
        1
    } else {
        previous + 1
    }
}

/// The only way to reach a terminal from a handle. Bounds, generation and slot
/// state are all checked here so nothing else indexes `slots`.
fn occupied(handle: i32) -> Option<Arc<Pty>> {
    let (index, generation) = unpack(handle)?;
    let table = lock_table();
    match table.slots.get(index) {
        Some(Slot::Occupied {
            generation: found,
            pty,
        }) if *found == generation => Some(Arc::clone(pty)),
        _ => None,
    }
}

fn allocate_slot(pty: Arc<Pty>) -> Option<i32> {
    let mut table = lock_table();
    let index = match table.free.pop_front() {
        Some(index) => index,
        None if table.slots.len() < MAX_TERMINALS => {
            table.slots.push(Slot::Free { generation: 0 });
            (table.slots.len() - 1) as u16
        }
        None => return None,
    };
    let slot = table.slots.get_mut(usize::from(index))?;
    let generation = next_generation(slot.generation());
    *slot = Slot::Occupied { generation, pty };
    Some(pack(index, generation))
}

/// Undoes `allocate_slot` when the reader thread could not be started. The slot
/// keeps its bumped generation, so the handle we never returned stays invalid.
fn release_slot(index: usize, generation: u32) {
    let mut table = lock_table();
    if let Some(slot) = table.slots.get_mut(index) {
        if slot.generation() == generation {
            *slot = Slot::Free { generation };
            table.free.push_back(index as u16);
        }
    }
}

/// `Occupied` → `Retired` at the rendezvous between the caller hanging up and
/// the reader thread finishing. Both parties call this; whichever arrives second
/// under the table lock performs the single transition. Retiring on either event
/// alone would be wrong: retire on the reader alone and `jpty_read` can no longer
/// report `-1`; retire on the caller alone and the exit code is lost.
fn retire_if_settled(index: usize, generation: u32, pty: &Pty) {
    if !(pty.shutdown.load(Ordering::SeqCst) && pty.finished.load(Ordering::SeqCst)) {
        return;
    }
    let code = pty.exit_code.load(Ordering::SeqCst);
    let mut table = lock_table();
    let Some(slot) = table.slots.get_mut(index) else {
        return;
    };
    if matches!(slot, Slot::Occupied { generation: found, .. } if *found == generation) {
        *slot = Slot::Retired { generation, code };
        table.free.push_back(index as u16);
    }
}

// ---------------------------------------------------------------- reader thread

enum Stop {
    /// The caller hung up.
    HungUp,
    /// The child's stdio is gone, or the descriptor failed.
    Eof,
}

fn read_loop(pty: &Pty) -> Stop {
    let mut wake_scratch = [0u8; 64];
    loop {
        {
            let mut ring = lock_ring(pty);
            while !pty.shutdown.load(Ordering::SeqCst) && ring.gate_closed() {
                ring = match pty.ready.wait(ring) {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
        }
        if pty.shutdown.load(Ordering::SeqCst) {
            return Stop::HungUp;
        }

        let mut fds = [
            libc::pollfd {
                fd: pty.master,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: pty.wake[0],
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return Stop::Eof;
        }
        let (master_ready, wake_ready) = (fds[0].revents != 0, fds[1].revents != 0);
        if wake_ready {
            unsafe {
                libc::read(
                    pty.wake[0],
                    wake_scratch.as_mut_ptr() as *mut c_void,
                    wake_scratch.len(),
                );
            }
            if pty.shutdown.load(Ordering::SeqCst) {
                return Stop::HungUp;
            }
        }
        if !master_ready {
            continue;
        }

        let (destination, room) = lock_ring(pty).writable_tail(READ_SIZE);
        if room == 0 {
            continue;
        }
        // The lock is released across the blocking syscall, so a drain never
        // waits on the kernel. One copy from the kernel, one to the caller's
        // buffer: the minimum the FFI shape allows.
        let read = unsafe { libc::read(pty.master, destination as *mut c_void, room) };
        if read > 0 {
            lock_ring(pty).commit(read as usize);
            continue;
        }
        if read == 0 {
            return Stop::Eof;
        }
        match errno() {
            libc::EINTR | libc::EAGAIN => continue,
            _ => return Stop::Eof,
        }
    }
}

fn run_reader(pty: Arc<Pty>, index: usize, generation: u32) {
    let stop = read_loop(&pty);

    // Shutdown order is the design, and it differs by reason.
    //
    // On EOF the descriptor stays open across `waitpid`, so a child that closed
    // its stdio but is still alive is not sent a spurious SIGHUP by the close.
    //
    // On an explicit hangup we already sent SIGHUP, and the child may be blocked
    // in `write(2)` against a PTY buffer nobody is draining any more. Closing
    // first is what releases it; leaving the descriptor open would park this
    // thread in `waitpid` for as long as that child chose to ignore SIGHUP.
    if matches!(stop, Stop::HungUp) {
        unsafe { libc::close(pty.master) };
    }
    let mut status: c_int = 0;
    let reaped = loop {
        let result = unsafe { libc::waitpid(pty.pid, &mut status, 0) };
        if result < 0 && errno() == libc::EINTR {
            continue;
        }
        break result;
    };
    if matches!(stop, Stop::Eof) {
        unsafe { libc::close(pty.master) };
    }

    // `ECHILD` means something else reaped our child. Reporting a guessed code
    // would be worse than reporting none, so the absence propagates.
    let code = if reaped < 0 {
        i32::MIN
    } else {
        exit_code_of(status)
    };
    pty.exit_code.store(code, Ordering::SeqCst);
    pty.finished.store(true, Ordering::SeqCst);
    // Only now. `jpty_read` returning -1 must imply `jpty_exit_code` has an
    // answer, or the TypeScript side sees a terminal that ended with no status.
    lock_ring(&pty).closed = true;
    pty.ready.notify_all();
    retire_if_settled(index, generation, &pty);
}

fn exit_code_of(status: c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        // What a shell reports, and what `TerminalState.exited` expects.
        128 + libc::WTERMSIG(status)
    } else {
        i32::MIN
    }
}

// ---------------------------------------------------------------- spawn

/// Spawn a child on a fresh PTY.
///
/// `argv` and `envp` are NULL-terminated arrays of C strings, exactly as
/// `execve` wants them. Nothing here parses a command line.
///
/// Returns a non-negative handle, or `-errno` when the terminal could not be
/// opened, or `-(2000 + errno)` when the child could not be started. `out_pid`
/// receives the pid, and carries nothing else.
///
/// # Safety
///
/// `path` and `cwd` must be NUL-terminated C strings, `argv` and `envp`
/// NULL-terminated arrays of them, and `out_pid` writable for one `i32`. All five
/// must stay valid until this returns — which is also when the child has finished
/// with them, because it has either exec'd or died by then.
#[no_mangle]
pub unsafe extern "C" fn jpty_spawn(
    path: *const c_char,
    argv: *const *const c_char,
    envp: *const *const c_char,
    cwd: *const c_char,
    cols: u16,
    rows: u16,
    out_pid: *mut i32,
) -> i32 {
    if path.is_null() || argv.is_null() || envp.is_null() || cwd.is_null() || out_pid.is_null() {
        return -libc::EINVAL;
    }

    // The exec-failure channel. Darwin has no `pipe2`, so CLOEXEC goes on both
    // ends by hand; the child's write end closing at a successful `execve` is
    // the *only* success signal the parent gets, which is what makes the errno
    // relayed rather than guessed.
    let mut err_pipe: [c_int; 2] = [-1, -1];
    if unsafe { libc::pipe(err_pipe.as_mut_ptr()) } != 0 {
        return -errno();
    }
    let (mut err_read, mut err_write) = (err_pipe[0], err_pipe[1]);
    // If the daemon's stdio was closed, the write end can land on 0, 1 or 2,
    // where `login_tty`'s `dup2` would clobber it and every spawn would report
    // success. Move it out of the way first.
    if err_write <= libc::STDERR_FILENO {
        let moved = unsafe { libc::fcntl(err_write, libc::F_DUPFD, 3) };
        if moved < 0 {
            return close_all_and(&[err_read, err_write], -errno());
        }
        unsafe { libc::close(err_write) };
        err_write = moved;
    }
    if err_read <= libc::STDERR_FILENO {
        let moved = unsafe { libc::fcntl(err_read, libc::F_DUPFD, 3) };
        if moved < 0 {
            return close_all_and(&[err_read, err_write], -errno());
        }
        unsafe { libc::close(err_read) };
        err_read = moved;
    }
    if !set_cloexec(err_read) || !set_cloexec(err_write) {
        return close_all_and(&[err_read, err_write], -errno());
    }

    // The reader thread's interrupt. Created before the fork so there is no
    // failure path left after it, and closed by the child's descriptor loop.
    let mut wake: [c_int; 2] = [-1, -1];
    if unsafe { libc::pipe(wake.as_mut_ptr()) } != 0 {
        return close_all_and(&[err_read, err_write], -errno());
    }
    // Non-blocking so a wake can never park the JavaScript thread, however many
    // unread bytes are already in the pipe.
    if !set_cloexec(wake[0])
        || !set_cloexec(wake[1])
        || !set_nonblocking(wake[0])
        || !set_nonblocking(wake[1])
    {
        return close_all_and(&[err_read, err_write, wake[0], wake[1]], -errno());
    }

    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let mut master: c_int = -1;
    let mut replica: c_int = -1;
    if unsafe {
        libc::openpty(
            &mut master,
            &mut replica,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &size as *const libc::winsize as *mut libc::winsize,
        )
    } != 0
    {
        return close_all_and(&[err_read, err_write, wake[0], wake[1]], -errno());
    }
    // `openpty` has no CLOEXEC option, and a master or replica inherited by some
    // other subprocess the daemon starts holds the PTY open forever — the child
    // would never reach EOF. `dup2` clears CLOEXEC on its target, so `login_tty`
    // putting the replica on 0/1/2 is unaffected.
    if !set_cloexec(master) || !set_cloexec(replica) {
        let failure = -errno();
        return close_all_and(
            &[err_read, err_write, wake[0], wake[1], master, replica],
            failure,
        );
    }

    // Prepared here because the child may not build them: `getrlimit` is not
    // async-signal-safe, and zeroing a struct in the child is a memset the
    // compiler is free to turn into a call.
    let fd_ceiling = descriptor_ceiling();
    let mut empty_mask: libc::sigset_t = unsafe { std::mem::zeroed() };
    let mut default_action: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut empty_mask);
        libc::sigemptyset(&mut default_action.sa_mask);
    }
    default_action.sa_sigaction = libc::SIG_DFL;
    default_action.sa_flags = 0;

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        let failure = -errno();
        return close_all_and(
            &[err_read, err_write, wake[0], wake[1], master, replica],
            failure,
        );
    }
    if pid == 0 {
        unsafe {
            child_exec(
                path,
                argv,
                envp,
                cwd,
                master,
                replica,
                err_read,
                err_write,
                fd_ceiling,
                &empty_mask,
                &default_action,
            )
        }
    }

    unsafe {
        libc::close(replica);
        libc::close(err_write);
    }
    let report = read_failure_report(err_read);
    unsafe { libc::close(err_read) };

    if let Some((stage, child_errno)) = report {
        reap(pid);
        unsafe { libc::close(master) };
        close_all(&[wake[0], wake[1]]);
        // `login_tty` failing is not "your program would not start", it is "we
        // could not build you a terminal", and the two land on different
        // sentences in front of the user.
        return if stage == STAGE_LOGIN_TTY {
            -child_errno
        } else {
            -(EXEC_FAILED_BIAS + child_errno)
        };
    }

    let pty = Arc::new(Pty {
        master,
        pid,
        wake,
        ring: Mutex::new(Ring::new(RING_CAPACITY_CEILING)),
        ready: Condvar::new(),
        exit_code: AtomicI32::new(i32::MIN),
        shutdown: AtomicBool::new(false),
        finished: AtomicBool::new(false),
    });
    let Some(handle) = allocate_slot(Arc::clone(&pty)) else {
        return abandon(&pty, -libc::EMFILE);
    };
    // `unpack` cannot fail on a handle `pack` just produced.
    let (index, generation) = unpack(handle).unwrap_or((0, 0));

    let owner = Arc::clone(&pty);
    let started = std::thread::Builder::new()
        .name(String::from("janela-pty"))
        .spawn(move || run_reader(owner, index, generation));
    if started.is_err() {
        release_slot(index, generation);
        return abandon(&pty, -libc::EAGAIN);
    }

    unsafe { *out_pid = pid };
    handle
}

/// Kills and reaps a child that will never get a reader thread, and closes the
/// descriptor here because no other thread owns it yet.
fn abandon(pty: &Pty, failure: i32) -> i32 {
    unsafe {
        libc::killpg(pty.pid, libc::SIGKILL);
        libc::close(pty.master);
    }
    reap(pty.pid);
    failure
}

/// Reads the child's failure record, or `None` when the pipe reached EOF with
/// nothing in it — which means CLOEXEC fired, which means `execve` succeeded.
///
/// This also makes the argv/envp lifetime provable rather than hopeful: by the
/// time `jpty_spawn` returns, the child has either exec'd (and the kernel has
/// copied both vectors into the new image) or died.
fn read_failure_report(err_read: c_int) -> Option<(i32, i32)> {
    let mut record = [0i32; 2];
    let wanted = std::mem::size_of_val(&record);
    let mut filled = 0usize;
    while filled < wanted {
        let read = unsafe {
            libc::read(
                err_read,
                (record.as_mut_ptr() as *mut u8).add(filled) as *mut c_void,
                wanted - filled,
            )
        };
        if read > 0 {
            filled += read as usize;
            continue;
        }
        if read < 0 && errno() == libc::EINTR {
            continue;
        }
        break;
    }
    if filled < wanted {
        return None;
    }
    let (stage, child_errno) = (record[0], record[1]);
    if (STAGE_LOGIN_TTY..=STAGE_EXECVE).contains(&stage) {
        Some((stage, child_errno))
    } else {
        Some((STAGE_EXECVE, libc::EINVAL))
    }
}

/// Everything between `fork` and `execve`.
///
/// Only syscalls on values the parent prepared: no allocation, no lock, no
/// panic, no slice indexing. `login_tty` and `ioctl` are not on POSIX's
/// async-signal-safe list, and are used anyway — `login_tty` *is* the reason this
/// layer exists, and Darwin's implementation is `setsid` + `ioctl(TIOCSCTTY)` +
/// three `dup2`s + a `close`, every one a syscall.
#[allow(clippy::too_many_arguments)]
unsafe fn child_exec(
    path: *const c_char,
    argv: *const *const c_char,
    envp: *const *const c_char,
    cwd: *const c_char,
    master: c_int,
    replica: c_int,
    err_read: c_int,
    err_write: c_int,
    fd_ceiling: c_int,
    empty_mask: *const libc::sigset_t,
    default_action: *const libc::sigaction,
) -> ! {
    // SAFETY: one block for the whole body, because the whole body is syscalls on
    // values the parent prepared. Scattering a block per line would look more
    // granular and prove nothing extra: the precondition is the same for every
    // line, and it is that this runs in a freshly forked child.
    unsafe {
        libc::close(master);
        // setsid + TIOCSCTTY + dup2 onto 0/1/2. The step neither `posix_spawn` nor
        // a JavaScript runtime can perform on Darwin.
        if libc::login_tty(replica) != 0 {
            report_failure(err_write, STAGE_LOGIN_TTY);
        }
        libc::close(err_read);

        let mut fd: c_int = 3;
        while fd < fd_ceiling {
            if fd != err_write {
                libc::close(fd);
            }
            fd += 1;
        }

        // `fork` inherits the forking thread's signal *mask*, and that thread is
        // Bun's. A child handed a blocked SIGTERM has subtly broken job control.
        libc::sigprocmask(libc::SIG_SETMASK, empty_mask, std::ptr::null_mut());
        let mut signal: c_int = 1;
        while signal < NSIG {
            if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                libc::sigaction(signal, default_action, std::ptr::null_mut());
            }
            signal += 1;
        }

        // Fatal, deliberately. A session whose directory was deleted must not get
        // a shell in the daemon's cwd: that is the bug class where an agent runs a
        // destructive command in the wrong tree.
        if libc::chdir(cwd) != 0 {
            report_failure(err_write, STAGE_CHDIR);
        }
        libc::execve(path, argv, envp);
        report_failure(err_write, STAGE_EXECVE)
    }
}

unsafe fn report_failure(err_write: c_int, stage: i32) -> ! {
    // SAFETY: same window as `child_exec`, and the record is a stack array.
    unsafe {
        let record: [i32; 2] = [stage, *libc::__error()];
        libc::write(
            err_write,
            record.as_ptr() as *const c_void,
            std::mem::size_of_val(&record),
        );
        libc::_exit(127)
    }
}

// ---------------------------------------------------------------- reading

/// Drain up to `len` bytes. Returns bytes written, 0 when empty, -1 when the
/// child is gone and the ring is drained, `JPTY_BAD_HANDLE` for a stale handle.
///
/// Copies `min(available, len)` and leaves the rest, so a caller whose buffer is
/// smaller than the ring gets the remainder on its next call rather than a
/// truncation. It never loops: one terminal's frame cost has to stay bounded.
///
/// # Safety
///
/// `out` must be writable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn jpty_read(handle: i32, out: *mut u8, len: usize) -> isize {
    let Some(pty) = occupied(handle) else {
        return JPTY_BAD_HANDLE as isize;
    };
    if out.is_null() {
        return JPTY_BAD_HANDLE as isize;
    }
    let mut ring = lock_ring(&pty);
    let drained = unsafe { ring.drain_into(out, len) };
    if drained == 0 {
        return if ring.closed { -1 } else { 0 };
    }
    drop(ring);
    // Unconditionally, and this is not laziness. Waking only when the drain
    // crossed a mark makes the wake depend on a size relationship between the
    // ring's marks and a buffer size declared in another language: get it wrong
    // and a parked reader is never woken, so one terminal goes permanently
    // silent during a flood with nothing logged and no CPU burned. A notify with
    // no waiter is a couple of atomics.
    pty.ready.notify_all();
    drained as isize
}

// ---------------------------------------------------------------- writing

/// Write user input to the child, handling partial writes and `EINTR`.
///
/// Runs on the caller's thread against a blocking master, so `EAGAIN` cannot
/// occur. It *can* block, when the child has stopped reading its stdin and the
/// tty's input queue is full. That is the correct behaviour for terminal input —
/// dropping a keystroke is data loss the user can see — and the queue that
/// absorbs it belongs one layer up, where a bounded blocking queue can hold it
/// off the request path.
///
/// # Safety
///
/// `data` must be readable for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn jpty_write(handle: i32, data: *const u8, len: usize) -> isize {
    let Some(pty) = occupied(handle) else {
        return JPTY_BAD_HANDLE as isize;
    };
    if data.is_null() {
        return JPTY_BAD_HANDLE as isize;
    }
    let mut written = 0usize;
    while written < len {
        let count = unsafe {
            libc::write(
                pty.master,
                data.add(written) as *const c_void,
                len - written,
            )
        };
        if count > 0 {
            written += count as usize;
            continue;
        }
        if count < 0 && errno() == libc::EINTR {
            continue;
        }
        return if written > 0 {
            written as isize
        } else {
            -errno() as isize
        };
    }
    written as isize
}

// ---------------------------------------------------------------- control

/// Apply a window size and let the kernel deliver `SIGWINCH`.
///
/// Pixel metrics are carried too, because programs that draw images (kitty
/// graphics, sixel) and some TUI layout code get it wrong without them.
#[no_mangle]
pub extern "C" fn jpty_resize(handle: i32, cols: u16, rows: u16, xpix: u16, ypix: u16) -> i32 {
    let Some(pty) = occupied(handle) else {
        return JPTY_BAD_HANDLE;
    };
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: xpix,
        ws_ypixel: ypix,
    };
    if unsafe { libc::ioctl(pty.master, libc::TIOCSWINSZ, &size) } != 0 {
        return -errno();
    }
    0
}

/// Signal the child's *process group*. Signalling only the direct child leaves
/// grandchildren orphaned and running.
#[no_mangle]
pub extern "C" fn jpty_signal(handle: i32, signal: i32) -> i32 {
    let Some(pty) = occupied(handle) else {
        return JPTY_BAD_HANDLE;
    };
    if unsafe { libc::killpg(pty.pid, signal) } != 0 {
        return -errno();
    }
    0
}

/// The child's exit status, or `i32::MIN` when there is not one to report.
#[no_mangle]
pub extern "C" fn jpty_exit_code(handle: i32) -> i32 {
    let Some((index, generation)) = unpack(handle) else {
        return i32::MIN;
    };
    let table = lock_table();
    match table.slots.get(index) {
        Some(Slot::Occupied {
            generation: found,
            pty,
        }) if *found == generation => pty.exit_code.load(Ordering::SeqCst),
        Some(Slot::Retired {
            generation: found,
            code,
        }) if *found == generation => *code,
        _ => i32::MIN,
    }
}

/// Hang up: SIGHUP the process group and let the reader thread wind itself down.
///
/// Never blocks, never joins, never closes the master fd from this thread —
/// closing a descriptor another thread is blocked reading hangs the caller on
/// Darwin. Idempotent.
#[no_mangle]
pub extern "C" fn jpty_close(handle: i32) {
    let Some(pty) = occupied(handle) else {
        return;
    };
    let Some((index, generation)) = unpack(handle) else {
        return;
    };
    hang_up(&pty);
    retire_if_settled(index, generation, &pty);
}

fn hang_up(pty: &Pty) {
    if !pty.shutdown.swap(true, Ordering::SeqCst) {
        // ESRCH — the group is already gone — is the common case, not an error.
        unsafe { libc::killpg(pty.pid, libc::SIGHUP) };
    }
    // Both wakes, because the reader parks in two places: `poll`, which the pipe
    // interrupts, and the high-water condvar, which it does not.
    let byte = 0u8;
    unsafe {
        libc::write(pty.wake[1], &byte as *const u8 as *const c_void, 1);
    }
    pty.ready.notify_all();
}

/// Hang up every terminal, for the daemon's SIGTERM path, and return how many.
///
/// One synchronous call rather than a loop in the caller: an `await` point in the
/// middle of a signal handler is exactly where the process dies with the sweep
/// half done, and a single native call cannot be half done.
#[no_mangle]
pub extern "C" fn jpty_drop_all() -> i32 {
    let live: Vec<(usize, u32, Arc<Pty>)> = {
        let table = lock_table();
        table
            .slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| match slot {
                Slot::Occupied { generation, pty } => Some((index, *generation, Arc::clone(pty))),
                _ => None,
            })
            .collect()
    };
    let mut count = 0;
    for (index, generation, pty) in &live {
        hang_up(pty);
        retire_if_settled(*index, *generation, pty);
        count += 1;
    }
    count
}

// ---------------------------------------------------------------- plumbing

fn errno() -> i32 {
    unsafe { *libc::__error() }
}

fn set_cloexec(fd: c_int) -> bool {
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) == 0 }
}

fn set_nonblocking(fd: c_int) -> bool {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0 }
}

fn descriptor_ceiling() -> c_int {
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return FD_CLOSE_CEILING;
    }
    if limit.rlim_cur >= FD_CLOSE_CEILING as libc::rlim_t {
        FD_CLOSE_CEILING
    } else {
        limit.rlim_cur as c_int
    }
}

fn reap(pid: pid_t) {
    let mut status: c_int = 0;
    loop {
        if unsafe { libc::waitpid(pid, &mut status, 0) } < 0 && errno() == libc::EINTR {
            continue;
        }
        break;
    }
}

fn close_all(fds: &[c_int]) {
    for fd in fds {
        unsafe { libc::close(*fd) };
    }
}

fn close_all_and(fds: &[c_int], failure: i32) -> i32 {
    close_all(fds);
    failure
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cstring(value: &str) -> Vec<u8> {
        let mut bytes = value.as_bytes().to_vec();
        bytes.push(0);
        bytes
    }

    /// Spawns a child and returns its handle and pid. Argument vectors are held
    /// by the caller for the duration of the call, as on the TypeScript side.
    fn spawn(program: &str, arguments: &[&str]) -> (i32, i32) {
        let path = cstring(program);
        let owned: Vec<Vec<u8>> = arguments.iter().map(|value| cstring(value)).collect();
        let mut argv: Vec<*const c_char> = owned
            .iter()
            .map(|value| value.as_ptr() as *const c_char)
            .collect();
        argv.push(std::ptr::null());
        let term = cstring("TERM=xterm-256color");
        let search_path = cstring("PATH=/usr/bin:/bin");
        let envp: Vec<*const c_char> = vec![
            term.as_ptr() as *const c_char,
            search_path.as_ptr() as *const c_char,
            std::ptr::null(),
        ];
        let cwd = cstring("/");
        let mut pid: i32 = 0;
        // SAFETY: every buffer is owned by this frame and outlives the call.
        let handle = unsafe {
            jpty_spawn(
                path.as_ptr() as *const c_char,
                argv.as_ptr(),
                envp.as_ptr(),
                cwd.as_ptr() as *const c_char,
                80,
                24,
                &mut pid,
            )
        };
        (handle, pid)
    }

    fn master_of(handle: i32) -> c_int {
        let pty = occupied(handle).expect("handle names a live terminal");
        pty.master
    }

    /// Drains until `needle` appears or a deadline passes, and returns everything
    /// seen. A fixed sleep followed by an assertion is a flake; a marker the
    /// child prints is not.
    fn drain_until(handle: i32, needle: &str) -> String {
        let mut buffer = vec![0u8; 64 * 1024];
        let mut seen = String::new();
        for _ in 0..1000 {
            // SAFETY: `buffer` is writable for its own length.
            let drained = unsafe { jpty_read(handle, buffer.as_mut_ptr(), buffer.len()) };
            if drained > 0 {
                seen.push_str(&String::from_utf8_lossy(&buffer[..drained as usize]));
                if seen.contains(needle) {
                    return seen;
                }
                continue;
            }
            if drained < 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
        seen
    }

    /// `cargo test` runs these in parallel threads of one process, and the handle
    /// table is process-global: a slot this test retires is the next slot another
    /// test's spawn hands out, which bumps the generation and makes a handle we
    /// still hold stale. Every test that allocates a slot takes this first.
    static EXCLUSIVE: Mutex<()> = Mutex::new(());

    fn exclusive() -> MutexGuard<'static, ()> {
        match EXCLUSIVE.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[test]
    fn the_child_closes_every_descriptor_above_stderr() {
        let _exclusive = exclusive();
        // A pipe with CLOEXEC deliberately left off. Every descriptor this
        // library opens is CLOEXEC, so a child would see nothing extra even with
        // no close loop at all — which means the loop can only be tested against
        // a descriptor CLOEXEC does not cover, and the parent has to be us.
        let mut leaked: [c_int; 2] = [-1, -1];
        assert_eq!(unsafe { libc::pipe(leaked.as_mut_ptr()) }, 0);

        let (handle, _) = spawn(
            "/bin/sh",
            &[
                "sh",
                "-c",
                "for n in 3 4 5 6 7 8 9 10 11 12 13 14; do [ -e /dev/fd/$n ] && echo OPEN=$n; done; echo FDDONE",
            ],
        );
        assert!(handle >= 0, "spawn failed with {handle}");
        let seen = drain_until(handle, "FDDONE");
        jpty_close(handle);
        close_all(&leaked);

        assert!(seen.contains("FDDONE"), "probe did not run: {seen:?}");
        assert!(
            !seen.contains("OPEN="),
            "the child inherited a descriptor: {seen:?}"
        );
    }
    #[test]
    fn resize_puts_all_four_winsize_fields_in_the_kernel() {
        let _exclusive = exclusive();
        // No stock CLI reports ws_xpixel, so the pixel half of the resize
        // contract is only observable from this side of the boundary.
        let (handle, _) = spawn("/bin/cat", &["cat"]);
        assert!(handle >= 0, "spawn failed with {handle}");
        assert_eq!(jpty_resize(handle, 120, 40, 1920, 1080), 0);

        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        let read_back = unsafe { libc::ioctl(master_of(handle), libc::TIOCGWINSZ, &mut size) };
        assert_eq!(read_back, 0);
        assert_eq!(
            (size.ws_col, size.ws_row, size.ws_xpixel, size.ws_ypixel),
            (120, 40, 1920, 1080)
        );
        jpty_close(handle);
    }

    #[test]
    fn a_handle_from_a_closed_terminal_is_an_error_rather_than_a_panic() {
        let _exclusive = exclusive();
        let (handle, _) = spawn("/bin/cat", &["cat"]);
        assert!(handle >= 0, "spawn failed with {handle}");
        jpty_close(handle);
        // The reader thread has to finish before the slot retires, and retirement
        // is what makes the handle stale.
        // SAFETY: `buffer` is a stack array, valid for reads and writes of its
        // own length. A stale handle is rejected before either pointer is used.
        let mut buffer = [0u8; 16];
        for _ in 0..500 {
            let drained = unsafe { jpty_read(handle, buffer.as_mut_ptr(), buffer.len()) };
            if drained == JPTY_BAD_HANDLE as isize {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        assert_eq!(
            unsafe { jpty_read(handle, buffer.as_mut_ptr(), buffer.len()) },
            JPTY_BAD_HANDLE as isize
        );
        assert_eq!(
            unsafe { jpty_write(handle, buffer.as_ptr(), buffer.len()) },
            JPTY_BAD_HANDLE as isize
        );
        assert_eq!(jpty_resize(handle, 80, 24, 0, 0), JPTY_BAD_HANDLE);
        assert_eq!(jpty_signal(handle, libc::SIGTERM), JPTY_BAD_HANDLE);
        // A retired slot keeps its exit code: SIGHUP, so 128 + 1.
        assert_eq!(jpty_exit_code(handle), 129);
        // Idempotent, and still not a panic.
        jpty_close(handle);
    }

    #[test]
    fn a_fabricated_handle_is_rejected_by_every_export() {
        let _exclusive = exclusive();
        // SAFETY: as above — a stack array, and no fabricated handle ever reaches
        // the pointer.
        let mut buffer = [0u8; 16];
        for handle in [-1, 0, 1, i32::MAX, pack(4095, MAX_GENERATION)] {
            assert_eq!(
                unsafe { jpty_read(handle, buffer.as_mut_ptr(), buffer.len()) },
                JPTY_BAD_HANDLE as isize
            );
            assert_eq!(
                unsafe { jpty_write(handle, buffer.as_ptr(), buffer.len()) },
                JPTY_BAD_HANDLE as isize
            );
            assert_eq!(jpty_resize(handle, 80, 24, 0, 0), JPTY_BAD_HANDLE);
            assert_eq!(jpty_signal(handle, libc::SIGTERM), JPTY_BAD_HANDLE);
            assert_eq!(jpty_exit_code(handle), i32::MIN);
            jpty_close(handle);
        }
    }

    #[test]
    fn a_recycled_slot_does_not_answer_to_the_previous_generation() {
        // The failure this guards is "closing one terminal killed another": a
        // reused index with no generation check makes a dead handle name a live
        // terminal, and killpg then reaches somebody else's process group.
        let index = 7usize;
        let first = pack(index as u16, 3);
        let second = pack(index as u16, 4);
        assert_ne!(first, second);
        assert_eq!(unpack(first), Some((index, 3)));
        assert_eq!(unpack(second), Some((index, 4)));
        // The sign bit stays clear, so no handle can be read as -errno.
        assert!(pack(4095, MAX_GENERATION) > 0);
        assert_eq!(next_generation(MAX_GENERATION), 1);
        // Generations start at 1, so handle 0 is never valid.
        assert_eq!(unpack(0), None);
        assert_eq!(unpack(pack(0, 1)), Some((0, 1)));
    }

    #[test]
    fn spawning_a_missing_executable_relays_the_childs_errno() {
        let (handle, _) = spawn("/nonexistent/janela/probe", &["probe"]);
        assert_eq!(handle, -(EXEC_FAILED_BIAS + libc::ENOENT));
    }

    #[test]
    fn a_ring_drain_leaves_the_remainder_and_wraps() {
        let mut ring = Ring::new(64);
        let source = [7u8; 40];
        let (destination, room) = ring.writable_tail(40);
        assert_eq!(room, 40);
        unsafe { std::ptr::copy_nonoverlapping(source.as_ptr(), destination, 40) };
        ring.commit(40);

        let mut out = [0u8; 30];
        let drained = unsafe { ring.drain_into(out.as_mut_ptr(), out.len()) };
        assert_eq!(drained, 30);
        assert_eq!(ring.len, 10);
        assert!(out.iter().all(|byte| *byte == 7));

        // 24 bytes to the end of the buffer, then a wrap: two copies, no loss.
        let more = [9u8; 30];
        let mut offered = 0;
        while offered < 30 {
            let (destination, room) = ring.writable_tail(30 - offered);
            assert!(room > 0);
            unsafe { std::ptr::copy_nonoverlapping(more.as_ptr().add(offered), destination, room) };
            ring.commit(room);
            offered += room;
        }
        assert_eq!(ring.len, 40);

        let mut all = [0u8; 64];
        let drained = unsafe { ring.drain_into(all.as_mut_ptr(), all.len()) };
        assert_eq!(drained, 40);
        assert_eq!(&all[..10], &[7u8; 10]);
        assert_eq!(&all[10..40], &[9u8; 30]);
        assert_eq!(ring.len, 0);
    }

    #[test]
    fn a_ring_grows_by_doubling_and_stops_at_the_ceiling() {
        let mut ring = Ring::new(RING_CAPACITY_CEILING);
        assert_eq!(ring.buf.len(), READ_SIZE);
        // Fill without ever draining: the reader's own gate is what stops it, so
        // the ring must refuse to grow past the ceiling on its own.
        let mut filled = 0usize;
        while filled < RING_CAPACITY_CEILING {
            let (_, room) = ring.writable_tail(READ_SIZE);
            if room == 0 {
                break;
            }
            ring.commit(room);
            filled += room;
        }
        assert_eq!(ring.buf.len(), RING_CAPACITY_CEILING);
        assert_eq!(ring.len, RING_CAPACITY_CEILING);
        let (_, room) = ring.writable_tail(READ_SIZE);
        assert_eq!(room, 0);
    }

    #[test]
    fn the_back_pressure_gate_latches_at_high_water_and_clears_at_low_water() {
        let mut ring = Ring::new(RING_CAPACITY_CEILING);
        ring.len = HIGH_WATER;
        assert!(ring.gate_closed());
        // Below the high mark but above the low one: still parked, which is the
        // hysteresis that stops the child stuttering at the boundary.
        ring.len = HIGH_WATER - 1;
        assert!(ring.gate_closed());
        ring.len = LOW_WATER + 1;
        assert!(ring.gate_closed());
        ring.len = LOW_WATER;
        assert!(!ring.gate_closed());
        ring.len = HIGH_WATER - 1;
        assert!(!ring.gate_closed());
        ring.len = 0;
    }
}
