# Janela Implementation Specification

What must be built, in dependency order, with the constraints each piece
carries. Derived from the accepted ADRs in [`decisions/`](decisions/), from
[`product.md`](product.md) and [`domain-model.md`](domain-model.md), and from
the interfaces and `TODO:` seams the packages already export. **Where this
document and the code disagree, the code is authoritative and this document is
the one to fix.**

---

## How to read this document

Every section below is one package or one app, in the order the layering gate
allows it to be built. "Layer" is the index from `scripts/layers.ts`; a
dependency must sit at a strictly lower layer, and a daemon package and a client
package may meet only at `@janela/core` or `@janela/protocol`.

| Section | Package | Layer, side | Tracking issue |
| --- | --- | --- | --- |
| § 1.1 | `@janela/pty` | 3, daemon | #16 (closed), #17 |
| § 1.2 | `@janela/git` | 3, daemon | #18 |
| § 1.3 | `@janela/db` | 3, daemon | #19, #40 |
| § 2.1 | `@janela/core` | 1, shared | #20 |
| § 3.1 | `@janela/terminal` | 4, daemon | #21 |
| § 3.2 | `@janela/session` | 5, daemon | #25, #26, #27 |
| § 3.3 | `@janela/protocol` | 2, shared | #22, #24 |
| § 3.3 | `@janela/daemon` | 6, daemon | #23, #35 |
| § 3.3 | `apps/daemon` (`janelad`) | 7, daemon | #35, #39 |
| § 4.1 | `@janela/client` | 6, client | #28 |
| § 4.2 | `@janela/design` | 7, client | none |
| § 4.3 | `@janela/terminal-ui` | 8, client | #29 |
| § 4.4 | `@janela/ui` | 9, client | #29, #37, #38 |
| § 4.5 | `apps/desktop` | 10, client | #30, #36, #39, #41 |
| § 5.3 | `@janela/forge` | 3, daemon | #33 |
| § 6.1 | repaint encoder, in `@janela/terminal` | 4, daemon | #32 |
| all | the survival proof — terminals outlive the app | — | #31 |

`@janela/support` (layer 0, shared) and `@janela/test-support` (layer 0, tool)
carry no section of their own; they appear wherever their contents are used.

The sources of truth are each package's `src/index.ts` contract and the `TODO:`
seams inside it, which are placed deliberately and carry a doc comment naming
what belongs there. The packages are mid-implementation: several sections below
describe a seam whose body is being written in the current wave of issues. This
document describes each seam as the ADRs and the current interfaces define it,
not as any half-written body defines it.

---

## Executive Summary

Janela is a macOS terminal session manager. Sessions survive the app closing.
Worktrees are one way a session's directory comes to exist, not the point of the
app. The terminal owns the keyboard.

**Core architecture thesis**: a session is a directory with terminals in it, and
a project is where sessions come from.

Two processes. `janelad` is a Bun process shipped as a single `bun build
--compile` binary (ADR 0020); it owns the PTYs — a Rust cdylib behind `bun:ffi`
(ADR 0021) — the headless emulator (`@xterm/headless`, ADR 0018), git, the
database (Prisma over `bun:sqlite` through a driver adapter we own, ADR 0019)
and the socket. `Janela.app` is a Tauri 2 shell (ADR 0024) whose Rust side opens
`~/.janela/run/janelad.sock` and relays frames as raw bytes to a React WebView
that renders with `@xterm/xterm`. The daemon is the source of truth; a client
renders a mirror and has no privileged path (ADR 0015).

Two consequences of the stack are worth stating once, here, because they change
what the rest of this document may assume.

- **The daemon and the client no longer share a terminal library.** ADR 0018 §
  Consequences: they run different packages from one family, so an emulator bug
  no longer reproduces identically on both sides. The protocol makes this
  survivable because it ships escape sequences rather than grids — the two sides
  need only agree on VT semantics.
- **Compile-time data-race checking is gone.** ADR 0020 replaced a language that
  checked isolation with a single-threaded event loop that does not. The
  isolation *rules* survive as ownership rules; the checker is gone, and the
  rule that replaces it is **never block the event loop**.

**Critical path to a minimum viable product**: `@janela/pty` → `@janela/git` →
`@janela/db` → `@janela/core` layout algebra → `@janela/terminal` →
`@janela/session` → `@janela/protocol` + `@janela/daemon` → `@janela/client` →
`@janela/ui` → repaint encoder (last).

---

## I. Foundation Layer

### 1.1 @janela/pty — Process and Terminal Byte Stream

**Status**: the spawn path is implemented (issue #16, closed):
`spawnPseudoTerminal`, the `NativePseudoTerminal` object it returns,
`hangUpEveryPseudoTerminal`, the Rust cdylib under `packages/pty/native/`
and the real-child suite in `packages/pty/src/pseudo-terminal.test.ts`. The
remaining seam is issue #17: the reader-thread water marks are in the
native library, and what is not yet wired is the daemon's once-per-frame
drain against them — `@janela/support`'s `boundedQueue` is still
unimplemented and the frame loop that calls `drain()` lives in
`@janela/daemon` (§ 3.3).

**Requirements**: ADR 0021 (`docs/decisions/0021-pty-native-layer.md`),
ADR 0020 (rules; reasoning in 0003), `docs/performance.md` § Terminal
throughput, non-negotiables #8 and #9 in `AGENTS.md`.

#### PseudoTerminal

Verbatim from `packages/pty/src/pseudo-terminal.ts`; doc comments elided.

```ts
export interface PseudoTerminal {
  readonly pid: number;
  drain(): TerminalBytes | undefined;
  write(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  signal(signal: number): void;
  exitCode(): number | undefined;
  close(): void;
}

export interface PseudoTerminalConfiguration {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: TerminalSize;
}

export type PseudoTerminalFailureDetail =
  | { readonly kind: "couldNotAllocateTerminal"; readonly errno: number }
  | { readonly kind: "couldNotStart"; readonly path: string; readonly errno: number }
  | { readonly kind: "notRunning" };

export class PseudoTerminalFailure extends UserFacingError {
  override readonly summary: string;
  readonly detail: PseudoTerminalFailureDetail;

  constructor(detail: PseudoTerminalFailureDetail) {
    // …
  }
}

export function spawnPseudoTerminal(configuration: PseudoTerminalConfiguration): PseudoTerminal;
export function hangUpEveryPseudoTerminal(): number;

export const SIGNAL = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 } as const;
export const CTRL_C = 0x03;
```

#### TerminalSize

Verbatim from `packages/pty/src/size.ts`.

```ts
export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export const DEFAULT_TERMINAL_SIZE: TerminalSize = {
  columns: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};
```

#### TerminalBytes and the read-side constants

Verbatim from `packages/pty/src/byte-stream.ts`, plus the marks the native
reader enforces, mirrored in `packages/support/src/bounded.ts`.

```ts
// packages/pty/src/byte-stream.ts
export const READ_SIZE = 128 * 1024;
export const DRAIN_BUFFER_SIZE = 1024 * 1024;
export const COALESCING_WINDOW_MS = 8;
export type TerminalBytes = Uint8Array;

// packages/support/src/bounded.ts
export interface WaterMarks {
  readonly highWater: number;
  readonly lowWater: number;
}

export const TERMINAL_WATER_MARKS: WaterMarks = {
  highWater: 4 * 1024 * 1024,
  lowWater: 1024 * 1024,
};
```

#### jpty_* — the native exports

Verbatim from `packages/pty/native/src/lib.rs`; doc comments and bodies
elided. Eight exports, and there is no ninth.

```rust
#[no_mangle]
pub unsafe extern "C" fn jpty_spawn(
    path: *const c_char,
    argv: *const *const c_char,
    envp: *const *const c_char,
    cwd: *const c_char,
    cols: u16,
    rows: u16,
    out_pid: *mut i32,
) -> i32 { /* … */ }

#[no_mangle]
pub unsafe extern "C" fn jpty_read(handle: i32, out: *mut u8, len: usize) -> isize { /* … */ }

#[no_mangle]
pub unsafe extern "C" fn jpty_write(handle: i32, data: *const u8, len: usize) -> isize { /* … */ }

#[no_mangle]
pub extern "C" fn jpty_resize(handle: i32, cols: u16, rows: u16, xpix: u16, ypix: u16) -> i32 { /* … */ }

#[no_mangle]
pub extern "C" fn jpty_signal(handle: i32, signal: i32) -> i32 { /* … */ }

#[no_mangle]
pub extern "C" fn jpty_exit_code(handle: i32) -> i32 { /* … */ }

#[no_mangle]
pub extern "C" fn jpty_close(handle: i32) { /* … */ }

#[no_mangle]
pub extern "C" fn jpty_drop_all() -> i32 { /* … */ }
```

#### NativePtyLibrary

Verbatim from `packages/pty/src/bindings.ts` — the only file in Janela
permitted to name `bun:ffi` (ADR 0021, gated by ADR 0022). `isize` and
`usize` cross the boundary as `bigint`.

```ts
export interface NativePtyLibrary {
  jpty_spawn(
    path: Pointer,
    argv: Pointer,
    envp: Pointer,
    cwd: Pointer,
    columns: number,
    rows: number,
    outPid: Pointer,
  ): number;
  jpty_read(handle: number, out: Pointer, capacity: number): bigint;
  jpty_write(handle: number, data: Pointer, length: number): bigint;
  jpty_resize(
    handle: number,
    columns: number,
    rows: number,
    pixelWidth: number,
    pixelHeight: number,
  ): number;
  jpty_signal(handle: number, signal: number): number;
  jpty_exit_code(handle: number): number;
  jpty_close(handle: number): void;
  jpty_drop_all(): number;
}

export type PtyHandle = number & { readonly __brand: "PtyHandle" };
export const JPTY_EXEC_FAILED_BIAS = 2000;
export const JPTY_NO_EXIT_CODE = -2147483648;
export function cString(value: string): Uint8Array;
export function cStringArray(values: readonly string[]): CStringArray;
```

**Implementation decisions**:

1. **The spawn sequence is one native call**: `openpty` → `fork` → in the
   child `login_tty(replica)` (which is `setsid` + `ioctl(TIOCSCTTY)` +
   three `dup2`s) → close every descriptor above stderr in an
   async-signal-safe loop up to `FD_CLOSE_CEILING` (`65536`) → reset the
   signal mask and every disposition to `SIG_DFL` for signals `1..NSIG`
   (`32`) except `SIGKILL` and `SIGSTOP` → `chdir` → `execve`. The
   descriptor loop is clamped because Bun's soft `RLIMIT_NOFILE` is
   1048576 and looping to it would cost a second per spawn; clamped it is
   65533 `close` calls, 12.4 ms on an M4, and it is the only
   async-signal-safe option Darwin offers — there is no `closefrom`, and
   `/dev/fd` enumeration opens a descriptor. If the daemon ever raises
   `RLIMIT_NOFILE` past the ceiling, descriptors above it leak into
   children. The sequence cannot use `posix_spawn`: Darwin has no
   `TIOCSCTTY` file action, and `POSIX_SPAWN_SETSID` yields a session
   *without* a controlling terminal, which breaks job control — no
   `SIGINT` from Ctrl-C, a failing `tcsetpgrp`, and every TUI that opens
   `/dev/tty` misbehaving. Between `fork` and `execve` the child issues
   only syscalls on values the parent prepared: no allocation, no lock,
   no panic. `argv` and `envp` are `char *const[]` arrays built in
   JavaScript by `cString` / `cStringArray` and **kept alive across the
   call** — the `marshalled` local in `spawnPseudoTerminal` is touched
   (`void marshalled`) after `jpty_spawn` returns, because Bun's collector
   does not know the native side holds those addresses. Their lifetime is
   provable rather than hopeful: `jpty_spawn` returns only once the child
   has exec'd, at which point the kernel has copied both vectors into the
   new image, or died. Failure comes back as a negative code in one of two
   disjoint bands: `code <= -JPTY_EXEC_FAILED_BIAS` ⇒ `couldNotStart` with
   `errno = -code - JPTY_EXEC_FAILED_BIAS`, otherwise
   `couldNotAllocateTerminal` with `errno = -code`. `JPTY_EXEC_FAILED_BIAS`
   is `2000`; `JPTY_BAD_HANDLE` is `-1000`, which every handle-taking
   export returns for a stale handle and which sits outside both bands
   because Darwin's `ELAST` is 106. `jpty_exit_code` reports "nothing to
   report" as `JPTY_NO_EXIT_CODE` (`-2147483648`, `i32::MIN`).

2. **The read path is a Rust reader thread**: one thread per terminal doing
   blocking reads of `READ_SIZE` (`128 * 1024`) into a ring buffer gated by
   `HIGH_WATER` (`4 * 1024 * 1024`) and `LOW_WATER` (`1024 * 1024`) — the
   same values `TERMINAL_WATER_MARKS` mirrors in
   `packages/support/src/bounded.ts`. Past the high mark the thread stops
   asking the PTY for more, the kernel's PTY buffer fills, and the child
   blocks in `write(2)` exactly as it would against a slow physical
   terminal; reading resumes at the low mark, a quarter of the high one, so
   the producer restarts in long runs rather than stuttering at a single
   boundary. Ring capacity is bounded structurally by
   `RING_CAPACITY_CEILING = HIGH_WATER + READ_SIZE`, because the mark is
   tested *before* a read and the overshoot is at most one read. **Bytes
   are never dropped**: a terminal stream is stateful, so a dropped byte
   truncates an escape sequence and desynchronises the parser — a
   corruption with a delay, not a lost line. A blocking read must not
   occupy the JavaScript event loop, which is why the channel is an OS
   thread rather than anything on the runtime's own. Measured: with the
   consumer stopped entirely, resident memory grew by about 4 MB and then
   stayed flat (ADR 0020, ADR 0021 § Verified behaviour).

3. **Drain once per frame, in one large call**: `drain()` returns up to
   `DRAIN_BUFFER_SIZE` (`1024 * 1024`) as a view into a per-terminal
   buffer allocated at spawn and reused every frame — **valid only until
   the next drain**, so anything that needs to keep the bytes copies them,
   and the emulator does not need to. An empty view means nothing is
   pending (not `undefined`, and not a fresh object 120 times a second per
   terminal); `undefined` means the child is gone and the ring is drained.
   It never loops: when more than a buffer's worth is waiting the
   remainder stays in the ring and arrives on the next call, so one
   terminal's frame cost stays bounded, and the native side wakes its
   reader after every non-empty drain so the backlog always makes
   progress. The window is `COALESCING_WINDOW_MS = 8`, one frame at 120 Hz
   — about 125 FFI calls per second per terminal regardless of throughput.
   The buffer size is derived, not picked: the emulator's curve is flat
   past 1 MB (8 KB writes sustain ~6 MB/s, 64 KiB ~32 MB/s, 1 MB
   ~140 MB/s), at the 133 MB/s the native reader sustains one 8 ms frame
   *is* 1.06 MB, and the per-live-terminal memory budget is 8 MB for
   everything including scrollback — which an 8 MB drain buffer would spend
   on its own.

4. **Pixel metrics cost a second call**: `jpty_spawn` carries cells only,
   which is the whole of `DEFAULT_TERMINAL_SIZE` (`80 × 24`, both pixel
   fields `0`), so `spawnPseudoTerminal` issues a `resize()` after spawn
   only when `pixelWidth` or `pixelHeight` is non-zero. `SIGWINCH`'s
   default action is to discard, so a child that has not exec'd yet is
   unaffected. `resize` clamps every field to a `u16` (`clampToWinsizeField`
   rejects non-finite values as `0` and truncates into `0..0xffff`, because
   `winsize` carries four `u16`s), and a resize landing on a terminal that
   died a frame ago is ignored rather than surfaced — it is a race we
   caused, and a dialog for it would be worse than silence.

5. **Signals target the process group**: `signal()` is `killpg`, and
   `ESRCH` — the group is already gone — is the common case rather than an
   error. Signalling only the direct child leaves grandchildren orphaned
   and running. Teardown is `SIGHUP` to the group; `SIGNAL` names the four
   numbers callers need so no layer above carries magic constants.

6. **The descriptor is closed by the thread that reads it, never by
   another.** Closing it from outside while a read is pending blocks the
   closing thread indefinitely on Darwin — measured during the migration
   as a test that hung rather than failed, and a long-known hazard of
   closing a descriptor out from under a reader. So `close()` sends
   `SIGHUP` to the group and lets the reader thread wind itself down and
   close; it never blocks, never joins, is idempotent, and returns in well
   under a millisecond (0.4 ms measured, ADR 0021). The slot goes from
   occupied to retired at a rendezvous between the hang-up and the reader
   thread finishing, whichever arrives second: retiring on the reader alone
   loses `drain()`'s end-of-stream signal, retiring on the caller alone
   loses the exit code.

7. **Ctrl-C is a byte, not a signal**: write `CTRL_C` (`0x03`) and let the
   line discipline deliver `SIGINT` to whatever process group is in the
   foreground. That is what a real terminal does, and the only thing that
   is correct once a shell has put a pipeline in its own group. `signal()`
   is for teardown, where the whole group *is* the target.

8. **A panic aborts**: a panic across the FFI boundary is undefined
   behaviour, so the release profile in `packages/pty/native/Cargo.toml`
   sets `panic = "abort"` (with `lto = true`, `codegen-units = 1`) and
   launchd restarts the daemon. The abort is a backstop, not a mechanism:
   every handle lookup returns an `Option`, no `unwrap` appears, and a
   poisoned mutex is recovered rather than propagated. The file also sets
   `#![deny(unsafe_op_in_unsafe_fn)]`, so an `unsafe fn` gets no free pass
   on its own body and every dereference sits in a block a reviewer can
   see. A fault here takes every terminal the user has running, which is
   why this package is tested hardest and why its only dependency is
   `libc`.

9. **Packaging**: the dylib is imported with a **literal** specifier —
   `import libraryPath from "../native/target/release/libjanela_pty.dylib"
   with { type: "file" }` — so `bun build --compile` embeds it and `dlopen`
   resolves it from Bun's virtual filesystem at runtime; a computed
   specifier resolves too late for the bundler to see and ships a binary
   with no library in it. Verified: the compiled daemon, copied to an empty
   directory, spawned a real PTY, so the daemon stays one file. The
   hardened runtime needs `com.apple.security.cs.disable-library-validation`,
   which it already carries so the daemon can spawn the user's own unsigned
   tooling. A missing library throws a plain `Error` at import
   ("@janela/pty's native library is missing. Run `bun run build:native`."),
   deliberately **not** a `PseudoTerminalFailure`: a stale
   `native/target/` is a build mistake, not something to show a user.

10. **Not this layer's job**: `executable` is an absolute path resolved by
    the caller — this layer does not search `PATH` — and a login shell's
    leading `-` in `argv[0]` is the caller's too. Both belong to
    `@janela/session`'s `ShellEnvironment` (§ 3.2), because doing either
    correctly needs the user's environment. `environment` is the complete
    environment for the child, never merged with the daemon's. Nothing is
    allocated until `spawnPseudoTerminal`, which is what makes 40
    configured terminals viable and why `idle` is a first-class
    `TerminalState`.

**Code versus spec notes**:

- The previous edition of this section quoted water marks an order of
  magnitude smaller than the code's, and a byte-stream delegate class.
  Both were already drift from the pre-migration design:
  `docs/performance.md` § Terminal throughput already said 4 MB / 1 MB,
  128 KB reads and an 8 ms window, which is what the shipped code does.
  The values in decision 2 are the code's.
- `docs/MIGRATION_MAP.md` § Daemon packages says of that retired
  byte-stream delegate class that "the water marks and the never-drop rule
  are unchanged". That sentence is about the *rule* — stop reading, never
  shed — not about the numbers the old spec printed; the numbers above are
  authoritative.
- ADR 0021's reference implementation was the spike; the shipped library
  supersedes it (see **Seams**).

**Test strategy**:

Real children, real PTYs, no fakes — `bun test` for the boundary,
`cargo test` for what is only observable from the native side.
`packages/pty/src/pseudo-terminal.test.ts` asserts:

- `/bin/echo` output arrives and the exit status is `0`, with a pid > 0.
- A signal death is reported as `128 + signo` (`kill -TERM $$` ⇒
  `128 + SIGNAL.SIGTERM`).
- Arbitrary bytes survive a round trip through the tty in raw mode
  (`stty raw -echo; exec cat`) — the byte fidelity that disqualified a
  string-only PTY package in ADR 0021.
- Hanging up reaches the child, which reports `128 + SIGHUP`, and reaches
  a **grandchild** (`set +m; sleep 300 &`), which is `killpg` and not
  `kill`.
- `close()` returns immediately while a read is pending, with `yes`
  guaranteeing a read is in flight. The historical failure is a hang, not
  a slow return.
- A resize delivers `SIGWINCH` and the new cell dimensions reach the child
  (`trap "stty size" WINCH`).
- A garbage size from a client cannot become a garbage ioctl — the clamp
  is asserted through a live child, not through the clamp function.
- The Ctrl-C byte interrupts a foreground job, which doubles as a
  disposition test.
- Signal dispositions are reset before exec: a runtime that ignores
  `SIGPIPE` would leave `yes | head -1` never finishing, so the deadline
  is the assertion.
- `hangUpEveryPseudoTerminal` reaches every child of every terminal.
- argv arrives verbatim whatever is in it (empty element, embedded space,
  tab, multi-byte character — none of which survive a joined command
  line), and a large environment (200 variables of 4 KB) arrives whole.
  A use-after-free cannot be asserted absent, so these assert the failure
  a wrong or truncated pointer array produces instead.
- A missing executable and an unexecutable one are different errnos
  (`ENOENT` vs `EACCES`), which proves the child's errno is relayed rather
  than guessed at from the parent's side.
- A working directory that no longer exists is fatal, not silent — the bug
  this closes is an agent running a destructive command in the wrong tree.
- A hung-up terminal answers `notRunning` rather than crashing the
  process, and `close()` is idempotent and never throws.
- An empty drain is an empty view, allocated once; a drain is a view into a
  reusable buffer, never a copy.
- Reading resumes after a backlog drains and one drain never exceeds
  `DRAIN_BUFFER_SIZE`, with the total exceeding twice the ring ceiling so
  the assertion is about the resume rather than the backlog. This is the
  test that kills a conditional wake: notify only when a drain crossed a
  mark, and a parked reader is never woken once the drain buffer is
  smaller than the distance between the marks — one terminal goes silent
  for good, with nothing logged and no CPU burned.
- A flooding terminal does not stall its neighbour.

`cargo test` in `packages/pty/native/` covers what the boundary hides: the
child closes every descriptor above stderr; a resize puts all four
`winsize` fields in the kernel including `ws_xpixel` / `ws_ypixel`, which
no stock CLI reports; a stale handle is an error rather than a panic on
every export; a recycled slot does not answer to the previous generation
(the failure being "closing one terminal killed another", after which
`killpg` reaches somebody else's process group); a missing executable
relays the child's errno; the ring drain leaves the remainder and wraps,
grows by doubling and stops at the ceiling; the gate latches at
`HIGH_WATER` and clears at `LOW_WATER`. `bun run test` in `packages/pty`
runs both. Throughput is measured by `bun run bench`, which is
`bun run bench/throughput.ts`.

**Seams**:

- `packages/pty/src/byte-stream.ts` holds the constants and the three
  rules that survived the runtime change verbatim: read on a dedicated
  thread, never the runtime's own; close the descriptor from the thread
  that reads it; drain once per frame in large chunks. Issue #17 owns
  wiring the daemon's frame loop to them.
- `packages/support/src/bounded.ts`'s `boundedQueue` is unimplemented
  (issue #23); the PTY's own bound is in Rust and does not depend on it.
- Provenance: `spikes/pty-bun-ffi/native/src/lib.rs` proved the design —
  133 MB/s sustained under `yes` with bounded memory, and 1.7 ms worst
  event-loop lag — and ADR 0021's verification table is its output. The
  shipped `packages/pty/native/src/lib.rs` supersedes it: the spike's 8 MB
  drain buffer, its computed dylib specifier and its missing
  `jpty_drop_all` are **not** the contract. Read the shipped library.
- ADR 0021 § Revisit when names the one export a second FFI need should
  become rather than a second surface: `launch_activate_socket` for the
  daemon's socket activation (§ 3.3, ADR 0017).

---

### 1.2 @janela/git — Worktree Operations

**Status**: Layer 3, daemon side. The contract is written and every function
body is a seam — `gitRunner`, `worktreeService`, `isTriviallySafe` and
`worktreeIncluding` all throw `not implemented`. Issue #18 owns them, together
with the `ProcessRunning` body they all stand on.

**Requirements**: ADR 0007 (`docs/decisions/0007-git-integration.md`), ADR 0013
(`docs/decisions/0013-worktreeinclude.md`), `docs/testing.md` § Git.

#### GitRunning

```ts
export interface GitRunning {
  run(args: readonly string[], directory: AbsolutePath): Promise<string>;
  probe(args: readonly string[], directory: AbsolutePath): Promise<GitOutcome>;
}

export interface GitOutcome {
  readonly standardOutput: string;
  readonly standardError: string;
  readonly exitCode: number;
  readonly succeeded: boolean;
}

export class GitFailure extends UserFacingError {
  readonly subcommand: string;
  readonly exitCode: number;
  readonly standardError: string;

  override readonly summary: string;

  constructor(subcommand: string, exitCode: number, standardError: string) {
    super(`git ${subcommand} failed`, standardError === "" ? undefined : { reason: standardError });
    this.summary = `git ${subcommand} failed.`;
    // …
  }
}

export function gitRunner(options?: { readonly executable?: string }): GitRunning;
```

#### WorktreeServing

```ts
export interface GitWorktree {
  readonly path: AbsolutePath;
  readonly head?: string;
  readonly branch?: string;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly lockReason?: string;
  readonly isPrunable: boolean;
}

export interface WorktreeServing {
  worktrees(repository: AbsolutePath): Promise<readonly GitWorktree[]>;

  createWorktree(request: {
    readonly repository: AbsolutePath;
    readonly directory: AbsolutePath;
    readonly branch?: string;
    readonly startPoint?: string;
  }): Promise<GitWorktree>;

  removalSafety(worktree: GitWorktree): Promise<WorktreeRemovalSafety>;

  removeWorktree(request: {
    readonly directory: AbsolutePath;
    readonly repository: AbsolutePath;
    readonly force: boolean;
  }): Promise<void>;
}

export interface WorktreeRemovalSafety {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly isLocked: boolean;
  readonly hasRunningSessions: boolean;
}

export function isTriviallySafe(safety: WorktreeRemovalSafety): boolean;

export function worktreeService(git: GitRunning): WorktreeServing;
```

#### WorktreeIncluding

```ts
export interface WorktreeIncluding {
  resolve(repository: AbsolutePath): Promise<readonly string[]>;

  copy(request: {
    readonly repository: AbsolutePath;
    readonly worktree: AbsolutePath;
    readonly paths: readonly string[];
  }): Promise<CopyReport>;
}

export interface CopyReport {
  readonly copied: readonly string[];
  readonly totalBytes: number;
  readonly usedFallbackCopy: boolean;
}

export function worktreeIncluding(git: GitRunning): WorktreeIncluding;
```

**Implementation decisions**:

1. **Always array arguments**: there is no shell, so there is no quoting and no
   injection — the whole bug class does not exist. Same rule as
   `LaunchProfile.command` and `AutomationCommand.command`.
2. **Always `-C <directory>`**: never `chdir` the process; sessions run
   concurrently and a process-wide current directory is shared state.
3. **`GIT_OPTIONAL_LOCKS=0` on read-only commands**: a background refresh never
   fights the user's own `git` for `index.lock`.
4. **Parse porcelain formats with `-z`**: worktree paths may contain newlines,
   so line-splitting is a bug, not a simplification.
5. **Resolve `git` from `PATH`**: never hardcode `/usr/bin/git`; the
   system-shipped git lags and lacks some worktree flags. Resolved once at
   daemon start from the login-shell `PATH`; `gitRunner({ executable })` exists
   so a test or a user override can name a different binary.
6. **`run` throws, `probe` reports**: `run` returns stdout and throws
   `GitFailure` on a non-zero exit; `probe` returns the whole `GitOutcome` and
   is for the commands where the exit code *is* the answer
   (`git rev-parse --verify`, `git diff --quiet`). Two entry points rather than
   one because "non-zero" means "broken" for the first set and "no" for the
   second, and a single function cannot mean both.
7. **`GitFailure` keeps stderr out of the headline**: `summary` is
   `git <subcommand> failed.` and git's stderr becomes `reason`, which the UI
   shows in a disclosure triangle. An empty stderr becomes nothing at all
   rather than an empty second sentence.
8. **The subprocess runner is `ProcessRunning`** from
   `@janela/support/process`, whose body is also owned by issue #18. That
   subpath is gated to the daemon side, and `node:child_process` is gated to
   that package. ADR 0007 names the previous stack's process API for this job;
   the code says `ProcessRunning`; the code wins.
9. **`@janela/git` and `@janela/forge` are peers and never import each other**:
   both sit at layer 3 and share only the subprocess plumbing beneath them.
   Peers cannot depend on peers, which `scripts/layers.ts` enforces now that no
   compiler says it for us.
10. **No caching, no reconciliation**: git is the source of truth and we
    re-read rather than try to stay in sync with it. No raw command string
    leaks above this API.
11. **`removalSafety` replaces the old boolean check**: it takes a
    `GitWorktree` and returns five named reasons — `hasUncommittedChanges`,
    `hasUntrackedFiles`, `hasUnpushedCommits`, `isLocked`,
    `hasRunningSessions` — so the confirmation dialog can say exactly what will
    be lost. "Are you sure?" is not a real warning. `isTriviallySafe` collapses
    the five back to one bool for the case where nothing needs saying.
    `hasRunningSessions` is not git's answer: `@janela/session` fills it in,
    because it is the only layer that knows what is live.
12. **A locked worktree is never removed**: `lockReason` arrives on
    `GitWorktree` from the porcelain output and is worth showing the user.
    `isPrunable` — git considers the directory gone — is an offer to prune, not
    licence to act alone.

**Test strategy**:

- **We do not mock git.** Worktree behaviour is not something a mock can
  meaningfully assert: `git worktree add` either works against a real
  repository or it does not, and a mock would only prove our assumptions. Tests
  use real repositories in temporary directories and accept the few hundred
  milliseconds.
- Fixtures are `gitFixture()` from `@janela/test-support`: a throwaway
  repository with one commit on `main`, hermetic on purpose —
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `commit.gpgsign=false` — so the suite passes on a
  machine with signing configured globally. Every path comes from
  `temporaryDirectory()`; a test that writes to a fixed path fails when files
  run in parallel, and fails intermittently.
- `worktrees()` against a repository with 0, 1 and 3 worktrees; assert the
  parse, including `branch`, `isDetached` and `lockReason`.
- `createWorktree()` with and without a start point; assert the directory
  exists and the branch is the one asked for; assert the returned value is what
  git reports afterwards.
- `createWorktree()` for a branch already checked out in another worktree
  raises `GitFailure` with git's stderr as `reason`.
- `removeWorktree()` on a clean worktree; assert it is gone from both the
  filesystem and `worktrees()`.
- `removalSafety()` four times, each asserting the *specific* flag: a worktree
  with uncommitted changes (`hasUncommittedChanges`), one with an untracked
  file (`hasUntrackedFiles`), one with a commit ahead of its upstream
  (`hasUnpushedCommits`), one under `git worktree lock` (`isLocked`). A test
  that only asserts "unsafe" would pass with every reason wired to the wrong
  check.
- A worktree whose path contains a newline survives `-z` parsing — the test
  that fails the moment someone splits on `\n`.
- `.worktreeinclude` asserts what landed **and what did not**: an
  ignored-but-unlisted directory, an untracked-but-unlisted file, and `.git`
  itself must all be absent from the new worktree. Verified against git 2.49,
  the command returns exactly the listed entries (ADR 0013).
- `CopyReport` is asserted, not just the filesystem: `copied`, `totalBytes`,
  and `usedFallbackCopy === false` on APFS.

**Seams**:

- `worktrees()` — `git worktree list --porcelain -z`, then parse the
  NUL-delimited records (`worktree`, `head`, `branch`, `bare`, `detached`,
  `locked`, `prunable`).
- `createWorktree()` — `git worktree add [-b <branch>] <path> [<start-point>]`,
  then re-read the list so the returned value is git's view rather than ours.
  The default placement is a sibling `.worktrees/<slug>` directory inside the
  repository's parent, overridable per creation.
- `removalSafety()` — `git status --porcelain`, `git log @{upstream}..HEAD`,
  plus the lock state already carried on the `GitWorktree` argument;
  `hasRunningSessions` comes from `@janela/session`.
- `removeWorktree()` — `git worktree remove [--force] <path>`, plus deleting
  the directory when git leaves it behind.
- `resolve()` — git does the matching, per ADR 0013:
  `ls-files -o -i --exclude-from=.worktreeinclude -z --directory`, run with
  `-C <repository>`. `-o -i` lists untracked files matching the given patterns,
  which is exactly the set we want because anything tracked is already in the
  new worktree; `--directory` collapses a wholly-untracked directory to one
  entry so `node_modules/` arrives as one path rather than 40,000. Returns
  empty when the file does not exist, which is the common case and not an
  error. We never write a gitignore matcher: ours would disagree with git's the
  first time someone used a negation.
- `copy()` — `clonefile(2)` moves the bytes, because on APFS a clone is
  metadata-only and that is what makes copying a 500 MB `node_modules` cost
  milliseconds. A non-APFS or cross-device failure falls back to a
  byte-for-byte copy and is reported through `usedFallbackCopy`: the fallback
  is allowed to be slow, it is not allowed to be silent, because a silent
  fallback is how the budget in `docs/performance.md` stops being met without
  anyone noticing. Symlinks are copied as symlinks, never dereferenced out of
  the repository; `.git` is excluded regardless of patterns; per-path failures
  are logged by path shape, skipped and non-fatal. Runs after the
  `git worktree add` and before any `worktreeCreated` automation command,
  because scripts depend on their `.env` already being present (ADR 0013,
  ADR 0014).
- **The 2 GB cap is stated by ADR 0013 and is not carried by this interface.**
  The ADR says total size is measured first, capped at 2 GB by default, and
  that past the cap the user is asked once with the actual number and the
  offending path — the session being created either way. `WorktreeIncluding`
  has no size argument, no cap constant and no prompt hook, so where the cap
  and its one-time prompt land is issue #26's decision. Do not read a number
  into this interface that it does not have.

---

### 1.3 @janela/db — Schema, Repositories and Driver Adapter

**Status**: seams unimplemented. `defaultDatabasePath`, `openDatabase` and
`temporaryDatabase` throw `not implemented`; the three repositories are
interfaces with no binding behind them; the driver adapter is a `TODO:` and a
type alias. Issue #19 owns the schema, the first migration and the
repositories; issue #40 owns the driver adapter over `bun:sqlite`.

**Requirements**: ADR 0019 (rules; reasoning in 0005), ADR 0015, ADR 0017
(migration failure and exit code), `docs/domain-model.md`.

#### JanelaDatabase

```ts
export interface JanelaDatabase {
  migrate(): Promise<void>;

  close(): Promise<void>;

  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly launchProfiles: LaunchProfileRepository;
}

export function defaultDatabasePath(): AbsolutePath {
  // …
}

export interface OpenOptions {
  readonly path: AbsolutePath;
  readonly pragmas?: Readonly<Record<string, string>>;
}

export function openDatabase(options: OpenOptions): Promise<JanelaDatabase> {
  // …
}

export function temporaryDatabase(): Promise<JanelaDatabase & { dispose(): Promise<void> }> {
  // …
}
```

`temporaryDatabase()` opens a **real database on a temporary path, not an
in-memory one**: Prisma's migration engine needs a file to migrate, and a test
that skips migrations does not test the thing most likely to break a user's
session list. The temporary directory comes from `@janela/test-support`.

#### Repositories

```ts
export interface ProjectRepository {
  all(): Promise<readonly Project[]>;
  find(id: ProjectID): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
  remove(id: ProjectID): Promise<void>;
}

export interface SessionRepository {
  all(): Promise<readonly Session[]>;
  find(id: SessionID): Promise<Session | undefined>;
  inProject(id: ProjectID): Promise<readonly Session[]>;
  standalone(): Promise<readonly Session[]>;
  save(session: Session): Promise<void>;
  remove(id: SessionID): Promise<void>;
  touch(id: SessionID): Promise<void>;
}

export interface LaunchProfileRepository {
  all(): Promise<readonly LaunchProfile[]>;
  find(id: LaunchProfileID): Promise<LaunchProfile | undefined>;
  save(profile: LaunchProfile): Promise<void>;
  remove(id: LaunchProfileID): Promise<void>;
  seedBuiltIns(): Promise<void>;
}
```

`ProjectRepository.remove` deletes a project **and everything in it** and does
not ask: the caller has already asked the removal question for each session
that owns a directory (§ 3.2). `SessionRepository.standalone()` is a
first-class case, not a leftover bucket. `seedBuiltIns()` inserts
`BUILT_IN_PROFILES` on first open without overwriting a user's edits.

#### JanelaSqliteAdapter

```ts
export type JanelaSqliteAdapter = unknown;
```

Deliberately `unknown` until issue #40 lands. The alias exists so that the
package can name its own adapter; it resolves to Prisma's `SqlDriverAdapter`
only once the implementation is written. Leaving it opaque means **no package
above `@janela/db` can start naming a Prisma type** — a generated client type
in a service signature is a leaked schema.

#### Schema

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
  runtime  = "bun"
}

datasource db {
  provider = "sqlite"
}

model LaunchProfile {
  id         String  @id
  name       String
  iconName   String
  command    String
  environment String
  isAgent    Boolean @default(false)
  isBuiltIn  Boolean @default(false)

  projects  Project[]
  terminals Terminal[]
}

model Project {
  id        String @id
  name      String
  directory String @unique

  remoteURL     String?
  defaultBranch String?
  forge         String?

  worktreeRoot     String  @default("siblingDirectory")
  worktreeRootPath String?
  isForgeEnabled   Boolean @default(true)
  accent           String  @default("none")
  isExpanded       Boolean @default(true)
  addedAt          DateTime

  defaultProfileId String?
  defaultProfile   LaunchProfile? @relation(fields: [defaultProfileId], references: [id], onDelete: SetNull)

  sessions   Session[]
  automation AutomationCommand[]
}

model Session {
  id        String   @id
  projectId String?
  project   Project? @relation(fields: [projectId], references: [id], onDelete: Cascade)

  name      String
  directory String

  backingKind           String
  worktreeBranch        String?
  worktreeBaseCommit    String?
  worktreeOwnership     String?
  worktreeIncludedPaths String?

  layout String

  accent       String   @default("none")
  position     Int
  createdAt    DateTime
  lastActiveAt DateTime
  isPinned     Boolean  @default(false)

  terminals Terminal[]

  @@index([projectId, position])
  @@index([lastActiveAt])
}

model Terminal {
  id        String  @id
  sessionId String
  session   Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  title                    String
  workingDirectoryOverride String?
  startsAutomatically      Boolean @default(false)
  role                     String  @default("user")
  position                 Int
  createdAt                DateTime

  profileId String?
  profile   LaunchProfile? @relation(fields: [profileId], references: [id], onDelete: SetNull)

  @@index([sessionId, position])
}

model AutomationCommand {
  id        String  @id
  projectId String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  event   String
  command String
  isEnabled      Boolean @default(true)
  timeoutSeconds Int     @default(30)
  position       Int

  @@index([projectId, event, position])
}
```

Five models, roughly kilobytes of data. Prisma 7 removed `url` from the
`datasource` block: the connection lives in `packages/db/prisma.config.ts`,
which configures the CLI only — the running daemon passes its own adapter to
the client constructor and never reads it. `LaunchProfile.command`,
`LaunchProfile.environment`, `AutomationCommand.command` and
`Session.worktreeIncludedPaths` are JSON columns; `Session.layout` is the
recursive tab/pane tree. Scrollback, secrets, notification bodies and anything
derivable from git or a forge are deliberately absent.

**Implementation decisions**:

1. **Prisma 7 with the WASM query compiler, and the driver adapter is ours**.
   Prisma 7 has no built-in SQLite driver, and both obvious adapters fail
   here — measured, not assumed:
   `@prisma/adapter-better-sqlite3` is unusable because Bun refuses
   `better-sqlite3` outright and points at `bun:sqlite` (oven-sh/bun#4290);
   `@prisma/adapter-libsql` works under `bun run` but fails compiled, because
   its native addon is not embedded by `bun build --compile` and the sidecar
   dies on a missing `@libsql/darwin-arm64`. `bun:sqlite` is built into the
   runtime, so there is nothing to embed and nothing to ship alongside. A
   third-party `bun:sqlite` adapter exists, works, and is the reference for
   ours, but a v0.x single-maintainer package is not where the daemon's only
   durable state belongs. The adapter contract, from the seam in
   `packages/db/src/adapter.ts`: `executeRaw(query)` returns the affected row
   count; `queryRaw(query)` returns `{ columnNames, columnTypes, rows }`;
   `transactionContext()` issues BEGIN / COMMIT / ROLLBACK, with no retry loop
   because there is one writer; plus `dispose()`, and the pragmas from
   `OpenOptions` applied on open. **Column typing is the part to test
   hardest**: SQLite is dynamically typed, so a column's type comes from the
   *declared* type when the statement has one and from the *value* otherwise.
   Getting it wrong does not throw — it hands Prisma a number where a string
   was expected, and surfaces much later as a decode error on a field nobody
   touched.
2. **Location and pragmas are unchanged** from what ADR 0019 inherited:
   `~/Library/Application Support/sh.janela.Janela/janela.sqlite`, not in a
   container because Janela is not sandboxed (ADR 0008). The four pragmas
   `OpenOptions.pragmas` documents, each a decision: WAL, so a read never
   blocks a write; `synchronous = NORMAL`, because losing the last few
   milliseconds of a session list to a power cut is not worth an fsync per
   commit; `foreign_keys = ON`, because the cascade rules *are* the product
   rules; and a 2 s busy timeout, so nothing blocks indefinitely on a lock
   that should not exist given there is one writer. The socket lives elsewhere
   (`~/.janela/run/janelad.sock`, ADR 0016); only the socket moved.
3. **`janelad` opens it and nothing else ever does** (ADR 0015, ADR 0019). WAL
   would tolerate multi-process access, so this is restraint rather than a
   limitation: two writers means two sources of truth and a class of bug where
   the client's view of a session disagrees with the process running it. A
   client package importing `@janela/db` is a layering bug — `@janela/ui` and
   `apps/desktop` do not link it at all — and `bun:sqlite` and
   `@prisma/client` are gated to `@janela/db` in `scripts/layers.ts`
   `GATED_MODULES` (ADR 0022).
4. **Migrations are `prisma migrate` output** under
   `packages/db/prisma/migrations/`: ordered SQL a human can read. Append-only
   — never edit a shipped migration, because a user's database is already at
   v3 and rewriting v3 does nothing for them while breaking everyone else.
   Every migration gets a test that opens a database at the previous version
   and migrates forward. `prisma db push` produces nothing to test and is
   forbidden outside a scratch database. **The migrations directory does not
   exist yet**; the first migration is generated by issue #19. Migration
   failure is the interesting error — the daemon cannot start, and the only
   way a user learns about it is a client that cannot connect — so it is
   logged clearly and exits non-zero, so launchd's `KeepAlive` does not spin
   (ADR 0017).
5. **Repositories take and return `@janela/core` values only.** A generated
   model appearing in a `@janela/session` signature would turn the schema into
   part of the brain's API; the layering gate enforces the import half, keeping
   types out is a review rule. Three mappings lose information on the way in
   and must restore it on the way out: `Session.backing` is a discriminator
   plus nullable columns, so a half-populated row is representable and is
   **rejected on read** via `backingViolations()` rather than producing a
   nonsense `Backing`; `SessionLayout` is recursive depth-bounded JSON,
   validated on encode and decode, and a corrupt layout is **repaired by
   dropping panes** rather than failing the load, because a session the user
   cannot open is worse than a session that lost a split; `command` and
   `environment` are JSON arrays and objects, and an argv array that
   round-trips into a string is the quoting bug class coming back in through
   the database.
6. **Cascade rules encode product rules**, declared once in the schema rather
   than spread across statements: a project cascades to its sessions and its
   automation commands, and a session cascades to its terminals; deleting a
   launch profile sets `Project.defaultProfileId` and `Terminal.profileId`
   null rather than deleting a descriptor, and a terminal with no profile
   falls back to the login shell; `Session.projectId` is nullable, so a
   standalone session belongs to no project, and it is `Cascade` rather than
   `SetNull` because a worktree-backed session orphaned from its project would
   have a `backing` nothing could interpret.
7. **Prisma's CLI runs on Node, not Bun**, and rejects unsupported Node
   versions by design. Bun runs everything we ship, but `prisma generate` and
   `prisma migrate` shell out to Node regardless, so the supported version is
   pinned in `.node-version` — **24.14.0** — and in CI. `bun run generate`
   must run before anything typechecks, and `bun run bootstrap` fails
   confusingly without a pinned Node. This is invisible from the code and
   costs an hour to rediscover.

**Test strategy**:

- `temporaryDatabase()` throughout: real SQLite, real migrations, a real file.
  We do not fake the database — the mapping and the migration are the two
  things most likely to break a user's session list, and a fake tests neither.
- Round-trip every repository method: save then find, for a project with
  automation commands, a session with terminals and a layout, and a launch
  profile; `all()`, `inProject()` and `standalone()` return what was written,
  in the stored order; `touch()` moves `lastActiveAt` and nothing else;
  `seedBuiltIns()` is idempotent and does not overwrite an edited built-in.
- The three cascade tests, one per product rule: removing a project deletes
  its sessions and their terminals; removing a launch profile leaves every
  referencing terminal alive with a null profile; removing a session deletes
  its terminals and leaves the project intact.
- A `SessionLayout` at depth 7 is refused on encode, and a stored layout
  beyond `MAXIMUM_PANE_DEPTH` is repaired on load by dropping panes, with the
  session still openable.
- The adapter column-typing matrix, the part worth testing hardest: a declared
  type on the statement versus a type inferred from the value, NULL in a
  column of each declared type, an integer value in a REAL column and the
  reverse, and text that looks numeric (`"007"`, `"1e3"`) surviving as text.
- A forward migration from version N−1: open a database at the previous
  version, migrate, assert the data survived. Added with every migration.

**Seams**:

- `packages/db/src/adapter.ts` — the four-point `TODO:` for the `bun:sqlite`
  driver adapter (issue #40).
- `packages/db/src/database.ts` — `defaultDatabasePath`, `openDatabase`,
  `temporaryDatabase` (issue #19).
- `packages/db/prisma/migrations/` — does not exist; created by the first
  `prisma migrate` run (issue #19).

---

## II. Domain and Layout

### 2.1 @janela/core — Domain Types and Layout Algebra

**Status**: the value types exist and are exercised by
`packages/core/src/domain.test.ts` and
`packages/core/src/session-layout.test.ts`; the layout algebra
(`splitPane`, `closeTerminal`, `focusNeighbour`, `resizeSplit`,
`repairLayout`) and the constructors (`identifier`, `absolutePath`, `now`,
the five `new*ID` factories) are `TODO:` seams owned by issue #20. Layer 1,
shared side (`scripts/layers.ts`): depends on `@janela/support` only, and is
the vocabulary both processes share, so it holds no I/O and nothing
process-specific.

**Requirements**: ADR 0009, ADR 0010, `docs/domain-model.md`, ADR 0015
(why these values cross a socket), ADR 0016 (why timestamps are strings).

#### Identifiers, paths and instants

```ts
declare const brand: unique symbol;

export type Identifier<Subject extends string> = string & { readonly [brand]: Subject };

export type ProjectID = Identifier<"Project">;
export type SessionID = Identifier<"Session">;
export type TerminalID = Identifier<"Terminal">;
export type LaunchProfileID = Identifier<"LaunchProfile">;
export type AutomationID = Identifier<"Automation">;

export function newProjectID(): ProjectID;
export function newSessionID(): SessionID;
export function newTerminalID(): TerminalID;
export function newLaunchProfileID(): LaunchProfileID;
export function newAutomationID(): AutomationID;

export function identifier<Subject extends string>(raw: string): Identifier<Subject>;

export type AbsolutePath = string & { readonly [brand]: "AbsolutePath" };
export function absolutePath(raw: string): AbsolutePath;

export type Instant = string & { readonly [brand]: "Instant" };
export function now(): Instant;
export function instant(raw: string | Date): Instant;
export function toDate(value: Instant): Date;
```

The brand is a `unique symbol` erased at runtime: these *are* strings, so
they encode to JSON as themselves and cross the socket for free.
`identifier()` re-brands a string read from the database or off the socket
and validates that it is a UUID; every call site is a place where an
untrusted string becomes a typed id, which is why the function is
deliberately explicit and greppable. `absolutePath()` throws when `raw` is
not absolute.

#### Session

```ts
export interface Session {
  readonly id: SessionID;
  projectID?: ProjectID;
  name: string;
  directory: AbsolutePath;
  backing: Backing;
  terminals: readonly TerminalDescriptor[];
  layout: SessionLayout;
  accent: Accent;
  createdAt: Instant;
  lastActiveAt: Instant;
  isPinned: boolean;
}

export type Backing =
  | { readonly kind: "folder" }
  | { readonly kind: "projectDirectory" }
  | { readonly kind: "worktree"; readonly binding: WorktreeBinding };

export function worktreeOf(session: Session): WorktreeBinding | undefined;
export function isStandalone(session: Session): boolean;
export function ownsItsDirectory(session: Session): boolean;

export interface WorktreeBinding {
  branch?: string;
  baseCommit?: string;
  path: AbsolutePath;
  ownership: WorktreeOwnership;
  includedPaths: readonly string[];
}

export type WorktreeOwnership = "managed" | "adopted";

export function backingViolations(session: Session): readonly string[];
```

`projectID` is optional and that is load-bearing: "just give me a terminal
in this folder" is a first-class case, not a degenerate one (ADR 0009).
`backing` records **how the directory came to exist** — provenance, not a
category of session. There is no `isWorktree` flag, no separate worktree
list and no second creation flow.

`WorktreeBinding` is a small value rather than an entity on purpose: a
worktree has no independent life cycle here, it is created with a session
and dies with it. `includedPaths` is recorded at creation time rather than
recomputed at deletion time, which is what lets the removal dialog name what
will be lost (ADR 0013).

#### Terminal

```ts
export interface TerminalDescriptor {
  readonly id: TerminalID;
  title: string;
  profileID?: LaunchProfileID;
  workingDirectoryOverride?: AbsolutePath;
  startsAutomatically: boolean;
  role: TerminalRole;
  createdAt: Instant;
}

export type TerminalRole =
  | { readonly kind: "user" }
  | { readonly kind: "automation"; readonly event: AutomationEvent };

export function isAutomation(role: TerminalRole): boolean;

export type TerminalState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "needsAttention" }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "failed"; readonly message: string };

export function isLive(state: TerminalState): boolean;

export interface GridSize {
  readonly columns: number;
  readonly rows: number;
}
```

`TerminalDescriptor` is the *persistable* description of a terminal: what to
run and where, never a live process. `idle` costs nothing, which is how forty
open terminals stay cheap and how "restore my layout" means "restore
descriptors".

`GridSize` lives here, not in `@janela/protocol`: the client votes a viewport
in cells, the daemon negotiates one, and both sides plus the database need the
type — putting it in the domain keeps the protocol from owning a value the
domain uses. Cells, not pixels: pixel metrics are a client fact and do not
survive two clients on different displays (ADR 0018).

#### Project, settings and automation

```ts
export interface Project {
  readonly id: ProjectID;
  name: string;
  directory: AbsolutePath;
  git?: GitDescriptor;
  settings: ProjectSettings;
  accent: Accent;
  isExpanded: boolean;
  addedAt: Instant;
}

export function supportsWorktrees(project: Project): boolean;

export interface GitDescriptor {
  remoteURL?: string;
  defaultBranch?: string;
  forge?: Forge;
}

export type Forge = "gitHub" | "gitLab";
export function forgeExecutable(forge: Forge): string;

export interface ProjectSettings {
  worktreeRoot: WorktreeRoot;
  automation: readonly AutomationCommand[];
  defaultProfileID?: LaunchProfileID;
  isForgeEnabled: boolean;
}

export type WorktreeRoot =
  | { readonly kind: "siblingDirectory" }
  | { readonly kind: "custom"; readonly directory: AbsolutePath };

export interface AutomationCommand {
  readonly id: AutomationID;
  event: AutomationEvent;
  command: readonly string[];
  isEnabled: boolean;
  timeoutSeconds: number;
}

export type AutomationEvent = "worktreeCreated" | "sessionStart" | "sessionTeardown";

export const AUTOMATION_EVENTS: readonly AutomationEvent[] = [
  "worktreeCreated",
  "sessionStart",
  "sessionTeardown",
];
```

`Project.directory` is git's *main worktree*, not the common dir.
`isExpanded` is a boolean on a value because collapsing and expanding a
project must do no work: expanding may never trigger git, disk or forge reads
(`docs/performance.md` § Interaction). `AutomationCommand.command` is
executable plus arguments, never handed to `sh -c`, so the quoting bug class
does not exist. Three automation events, and a fourth needs an ADR — this is
not a task runner: no scheduling, no retry, no dependency graph, no
conditional execution. `timeoutSeconds` bounds `sessionTeardown` only; the
other two events block nothing.

#### Launch profiles and accents

```ts
export interface LaunchProfile {
  readonly id: LaunchProfileID;
  name: string;
  iconName: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  isAgent: boolean;
  isBuiltIn: boolean;
}

export const BUILT_IN_PROFILES: readonly Omit<LaunchProfile, "id">[] = [
  { name: "Shell", iconName: "terminal", command: [], environment: {}, isAgent: false, isBuiltIn: true },
  { name: "Claude Code", iconName: "sparkles", command: ["claude"], environment: {}, isAgent: true, isBuiltIn: true },
  { name: "Codex", iconName: "code", command: ["codex"], environment: {}, isAgent: true, isBuiltIn: true },
  { name: "OpenCode", iconName: "box", command: ["opencode"], environment: {}, isAgent: true, isBuiltIn: true },
];

export const ACCENTS = [
  "none",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "graphite",
] as const;

export type Accent = (typeof ACCENTS)[number];
```

`iconName` names a Lucide icon resolved by `@janela/design`; the field is
presentational, and a name the client does not recognise falls back to the
terminal glyph rather than rendering nothing (ADR 0023). An empty `command`
means the user's login shell, resolved at launch by `@janela/session`. Ids
for the built-ins are assigned at seed time rather than baked in, because a
hardcoded id would collide with a user's own copy of a built-in. Built-ins
are *suggestions, not integrations*: a profile whose binary is absent from
`PATH` is hidden rather than shown broken, and adding an entry must never
require code changes elsewhere. `ACCENTS[0]` is `"none"`, so absence is a
value rather than a null.

#### Session layout

```ts
export interface SessionLayout {
  readonly tabs: readonly LayoutTab[];
  readonly focusedTabIndex: number;
}

export interface LayoutTab {
  readonly title?: string;
  readonly root: Pane;
  readonly focusedTerminalID: TerminalID;
}

export type Pane =
  | { readonly kind: "terminal"; readonly id: TerminalID }
  | {
      readonly kind: "split";
      readonly axis: Axis;
      readonly fraction: number;
      readonly first: Pane;
      readonly second: Pane;
    };

export type Axis = "horizontal" | "vertical";

export const MAXIMUM_PANE_DEPTH = 6;
export const FRACTION_RANGE = { minimum: 0.05, maximum: 0.95 } as const;

export const emptyLayout: SessionLayout = { tabs: [], focusedTabIndex: 0 };

export function singleTerminalLayout(id: TerminalID): SessionLayout;
export function focusedTab(layout: SessionLayout): LayoutTab | undefined;
export function layoutTerminalIDs(layout: SessionLayout): readonly TerminalID[];
export function paneTerminalIDs(pane: Pane): readonly TerminalID[];
export function paneDepth(pane: Pane): number;

export function splitPane(
  layout: SessionLayout,
  terminal: TerminalID,
  newTerminal: TerminalID,
  axis: Axis,
): SessionLayout;

export function closeTerminal(layout: SessionLayout, terminal: TerminalID): SessionLayout;

export function focusNeighbour(
  layout: SessionLayout,
  direction: "left" | "right" | "up" | "down",
): SessionLayout;

export function resizeSplit(
  layout: SessionLayout,
  terminal: TerminalID,
  fraction: number,
): SessionLayout;

export function repairLayout(
  layout: SessionLayout,
  existing: readonly TerminalID[],
): SessionLayout;
```

`Pane` is binary rather than n-ary because every split operation the UI
offers is binary, and because promoting a sibling when a pane closes is
trivial in a binary tree and fiddly in an n-ary one. `paneDepth` counts a
bare terminal as 1.

**Implementation decisions**:

1. **Values are plain, JSON-shaped and immutable**: timestamps are ISO-8601
   strings in UTC and paths are branded strings, because every value in this
   package crosses a socket as JSON (ADR 0015, ADR 0016). No `Date` and no
   `URL` in a domain value: a `Date` needs a revival pass on the far side
   that one forgotten call site turns into a string masquerading as a date,
   and a `URL` round-trip through percent-encoding is a bug waiting for the
   first directory with a space in it. `toDate()` exists for formatting at
   the edge, never for storage.
2. **Nothing here does I/O, and nothing here is `async`**: if something in
   this package needs an `await`, it belongs in a higher package. Layer 1
   with `@janela/support` as its only dependency makes that mechanical
   (`scripts/layers.ts`).
3. **Four nouns is the concept budget**: project, session, terminal, launch
   profile (ADR 0009, `docs/product.md` § 1). Two levels of containment,
   never three. Standalone sessions are a first-class case, not a fake
   "Ungrouped" project.
4. **Every layout function is pure and returns a new layout.** `splitPane`
   returns the layout unchanged when `terminal` is not in the tree.
   `resizeSplit` clamps. Nothing mutates its argument, which is what makes
   the whole algebra testable with values in and values out and no fixtures.
5. **Depth beyond `MAXIMUM_PANE_DEPTH = 6` is refused, not truncated.** The
   seam in `session-layout.ts` states it: "Depth is bounded at
   MAXIMUM_PANE_DEPTH; a split that would exceed it is refused rather than
   truncated", and `splitPane`'s contract is to return the layout unchanged
   in that case. ADR 0010 says decoding truncates and logs; the code says a
   deeper tree is refused and the split simply does not happen; the code
   wins. Refusing is the better answer for the same reason the bound exists:
   `Pane` is recursive and read back from a persisted blob, and silently
   reshaping a user's arrangement is worse than declining to deepen it.
6. **A fraction is clamped to `FRACTION_RANGE = { minimum: 0.05, maximum:
   0.95 }` on construction and on decode.** A pane you cannot see is a pane
   you cannot close.
7. **Referential integrity is repaired, not enforced.** `repairLayout` drops
   panes naming terminals that no longer exist, clamps every fraction, and
   repairs a focus pointing at nothing (falling back to the first terminal);
   `focusedTabIndex` is clamped rather than trusted. It is called on every
   load and must degrade, never throw — the alternative is a session the user
   cannot open. Within a valid layout the rule is that every `TerminalID` in
   the tree exists in `session.terminals` exactly once.
8. **Closing collapses.** `closeTerminal` promotes the removed pane's
   sibling into the parent's place; closing the last terminal in a tab closes
   the tab. Closing the last tab returns `emptyLayout`, and the "the session
   is left holding one idle terminal, never zero" half of the rule belongs to
   the caller in `@janela/session`, because creating a terminal is not
   something a pure function may do.
9. **Focus traversal is spatial**: `focusNeighbour(layout, direction)` with
   `"left" | "right" | "up" | "down"`, returning the layout unchanged at an
   edge. This replaces the earlier `focusNext` / `focusPrevious` pair — the
   binding is `⌘⌥←→↑↓` (ADR 0010), and a linear next/previous over a split
   tree does not answer the question the arrow key asks.
10. **`backingViolations` is checked on decode, never trusted.** A session
    that violates one of these arrived from somewhere that should not have
    produced it; `@janela/db` runs it on load and the protocol layer runs it
    on decode.

    | Backing | `projectID` | May delete the directory |
    | --- | --- | --- |
    | `folder` | must be absent | never |
    | `projectDirectory` | must be present | never — it is the user's checkout |
    | `worktree` | must be present | only when `ownership === "managed"` |

    `ownsItsDirectory` is the predicate over that last column: true only for
    a worktree Janela created. An adopted worktree existed before us and we
    do not destroy it on a hunch; a project directory is the user's checkout
    and destroying it would be catastrophic. `isStandalone` is the
    `folder`-with-no-`projectID` case: no project, so no automation, no
    worktree option and no forge state — nothing else differs.

**Test strategy**:

- Pure unit tests, milliseconds each, no fixtures: values in, values out.
  `domain.test.ts` and `session-layout.test.ts` are the model for the rest of
  the suite.
- A standalone session has no project, no repository and no worktree:
  `isStandalone` true, `projectID` absent, `worktreeOf` returns `undefined`.
- A `projectDirectory` session never owns its directory:
  `ownsItsDirectory` false, and `backingViolations` non-empty when
  `projectID` is absent.
- Both worktree ownerships expose their binding uniformly: `worktreeOf`
  returns the binding for `managed` and `adopted` alike, so callers never
  branch on ownership to read a branch name.
- Only a Janela-created worktree may be deleted from disk:
  `ownsItsDirectory` true for `ownership: "managed"`, false for `"adopted"`.
- `backingViolations` returns empty for each of the three legal
  backing/`projectID` combinations and names the reason for each illegal one.
- Splitting keeps every terminal id present exactly once:
  `layoutTerminalIDs(splitPane(…))` equals the previous ids plus the new one,
  with no duplicates.
- Closing promotes a sibling: after `closeTerminal`, the sibling's pane sits
  where the split was, `paneDepth` has dropped by one, and closing the last
  terminal in a tab removes the tab.
- Depth 7 is refused: `splitPane` on a tree already at
  `MAXIMUM_PANE_DEPTH` returns the layout unchanged, and `paneDepth` never
  exceeds 6.
- A fraction outside `FRACTION_RANGE` is clamped by `resizeSplit` and by
  `repairLayout`, at both ends.
- `repairLayout` drops a pane naming a terminal absent from `existing`,
  repairs a `focusedTerminalID` that names nothing, clamps
  `focusedTabIndex`, and never throws.
- Every value round-trips through `JSON.stringify` / `JSON.parse` unchanged
  — the check that replaces any language-level codec, and the one that
  proves these types are cheap to put on the socket.
- The concept budget is pinned mechanically: `AUTOMATION_EVENTS` has exactly
  three entries, `BUILT_IN_PROFILES` commands are argv arrays with no shell
  metacharacters, `Shell` has an empty command, `ACCENTS[0]` is `"none"`.

---

## III. Daemon-Side Implementation

### 3.1 @janela/terminal — Emulator Seam and Live Terminal

**Status**: implemented (issue #21). `HeadlessEmulator` in
`packages/terminal/src/headless-emulator.ts` is the only module that names
`@xterm/headless`; `repaintSince` is the sanctioned full repaint until #32
lands. The gated-module rules are in `scripts/layers.ts`.

**Requirements**: ADR 0018 (rules; reasoning in 0004), ADR 0015, ADR 0006
(no inferred agent state), `docs/performance.md` § Terminal throughput.

#### TerminalEmulating

From `packages/terminal/src/terminal-emulating.ts`:

```ts
export interface TerminalEmulating {
  feed(bytes: TerminalBytes): void;

  readonly size: GridSize;

  resize(size: GridSize): void;

  readonly revision: number;

  repaintSince(revision: number): Uint8Array;

  fullRepaint(): Uint8Array;

  snapshotText(options: { readonly includeScrollback: boolean }): string;

  clearScrollback(): void;

  events: TerminalEventSink | undefined;

  dispose(): void;
}

export interface TerminalEventSink {
  onTitle(title: string): void;

  onWorkingDirectory(path: string): void;

  onAttention(notification: TerminalNotification): void;

  onPromptMark(mark: PromptMark): void;

  onExit(code: number): void;
}

export interface TerminalNotification {
  readonly title?: string;
  readonly body?: string;
}

export type PromptMark =
  | { readonly kind: "promptStart" }
  | { readonly kind: "commandStart" }
  | { readonly kind: "commandFinished"; readonly exitCode?: number };

export const DEFAULT_SCROLLBACK = 10_000;

/** Longest OSC-derived string that may leave the emulator. */
export const MAX_OSC_TEXT_LENGTH = 1024;
```

`createEmulator` lives beside its implementation, in
`packages/terminal/src/headless-emulator.ts`, and is re-exported from the
package index — a seam that imports its own implementation is a seam pointing
the wrong way:

```ts
export function createEmulator(options: {
  readonly size: GridSize;
  readonly scrollback: number;
}): TerminalEmulating {
  // …
}
```

#### LiveTerminal

From `packages/terminal/src/live-terminal.ts`:

```ts
export interface LiveTerminal {
  readonly id: TerminalID;
  readonly sessionID: SessionID;
  readonly descriptor: TerminalDescriptor;
  readonly state: TerminalState;

  readonly displayTitle: string;

  readonly reportedWorkingDirectory?: string;

  start(): Promise<void>;

  stop(): Promise<void>;

  restart(): Promise<void>;

  send(bytes: Uint8Array): void;

  attach(client: string, viewport: GridSize): GridSize;

  detach(client: string): GridSize | undefined;

  /** Drains the PTY once and feeds the emulator. Once per frame, per terminal. */
  drain(): void;

  repaintFor(client: string): Uint8Array;

  fullRepaintFor(client: string): Uint8Array;

  snapshotText(options: { readonly includeScrollback: boolean }): string;

  events: TerminalEventSink | undefined;
}

export function negotiatedSize(viewports: readonly GridSize[]): GridSize {
  // …
}

export function createLiveTerminal(options: {
  readonly descriptor: TerminalDescriptor;
  readonly sessionID: SessionID;
  readonly launch: TerminalLaunch;
  /** Defaults to DEFAULT_SCROLLBACK. */
  readonly scrollback?: number;
  /** Absent means silent: `@janela/support`'s `log()` is not implemented yet. */
  readonly log?: Logger;
  /** The spawn seam. Production passes nothing; the read-failure test scripts it. */
  readonly spawn?: (configuration: PseudoTerminalConfiguration) => PseudoTerminal;
}): LiveTerminal {
  // …
}

export interface TerminalLaunch {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: GridSize;
}
```

#### TerminalRegistry

From `packages/terminal/src/registry.ts`:

```ts
export interface TerminalRegistry {
  get(id: TerminalID): LiveTerminal | undefined;
  register(terminal: LiveTerminal): void;
  remove(id: TerminalID): void;

  inSession(id: SessionID): readonly LiveTerminal[];

  readonly liveCount: number;

  hangUpAll(): Promise<void>;
}

export function createTerminalRegistry(): TerminalRegistry {
  // …
}
```

**Implementation decisions**:

1. **One library, named once**: the emulator is backed by `@xterm/headless`
   6.0.0 with `@xterm/addon-serialize` 0.14.0
   (`packages/terminal/package.json`). `@janela/terminal` is the only package
   allowed to import either, and `@xterm/addon-*` is allowed only to it and to
   `@janela/terminal-ui`; the client-side renderer library `@xterm/xterm` is
   allowed only to `@janela/terminal-ui`. This is enforced by the
   `GATED_MODULES` table in `scripts/layers.ts`, not by review — a package
   manifest no longer does it for us. `createEmulator` is the single place a
   library is named; everything above this package sees `TerminalEmulating`,
   and the cost of swapping engines later is exactly the size of that
   interface.

2. **Two seams, two libraries — the guarantee is now a convention**: the daemon
   runs `@xterm/headless` and the client runs `@xterm/xterm`. They are the same
   family but they are *different* libraries, so an emulator bug no longer
   reproduces identically on both sides and a divergence between what the
   daemon believes is on screen and what the client draws is newly possible.
   ADR 0018's "they cannot disagree because they are the same code" has become
   "they should not disagree" — a weaker guarantee, held by convention. It is
   survivable because the protocol ships escape sequences, not grids: the two
   sides need only agree on VT semantics, never on an internal grid format.
   Mitigation is the two-emulator round-trip test below, plus a variant with
   the client's renderer on the receiving end, which is worth writing before
   v1. Three further consequences of the same choice, recorded as constraints
   rather than left implicit:
   - The memory floor per terminal is higher, because the grid is a JavaScript
     object graph rather than a native one and scrollback is bounded in a
     garbage-collected heap. `DEFAULT_SCROLLBACK = 10_000` is where that bound
     lives, and it is bounded next to the thing it bounds because an unbounded
     ring buffer is the most obvious way to violate non-negotiable #9.
   - xterm.js's open correctness issues are inherited, notably around reflow —
     and reflow is an *interactive* path here rather than a window-resize edge
     case, because dragging a split resizes its neighbour.
   - Retina pixel metrics (`ws_xpixel`/`ws_ypixel`) remain a *client* fact set
     by the daemon, and mixed-DPI clients attached to one terminal remain a
     known open edge, neither fixed nor worsened by the migration.

   If the throughput budget is ever missed **with the once-per-frame feed
   pattern in place** — measured under a `yes` flood or a full-screen TUI
   repaint, not announced — the first move is a native VT parser behind the
   PTY's existing cdylib and `bun:ffi` boundary, so it costs one more export
   rather than a second native artifact. For the record of what this seam used
   to hold: ADR 0018 replaced the engine chosen before it (ADR 0018 carries the
   decision; reasoning in 0004) behind these same two seams, which is the best
   evidence available that the boundary was real rather than an artefact of the
   old stack.

3. **`feed` is called at most once per frame, with the whole coalesced chunk.**
   This is a correctness-adjacent rule, not a tuning knob, and the measured
   curve is the reason (ADR 0018, `@xterm/headless` 6.0 on an M-series Mac,
   plain-text flood): 8 KiB chunks sustain ~6 MB/s, 64 KiB chunks ~32 MB/s,
   1 MB chunks ~140 MB/s. Per-read feeding misses the ≥ 100 MB/s budget by a
   factor of fifteen; the once-per-frame coalescing passes it comfortably. An
   escape-sequence-heavy payload — a full-screen TUI recolouring every cell —
   sustains ~10 MB/s, which is ~776 complete 120×40 repaints per second, far
   past what any client renders. The rule is recorded next to the code that
   must obey it, in `packages/pty/src/byte-stream.ts`.

4. **`revision` is monotonic and every client's last-seen value is a number.**
   The revision is bumped whenever the grid changes; `repaintSince(revision)`
   is relative to a client's own last-seen number. A client's revision is
   never `undefined` meaning "everything": attach is an explicit full repaint,
   and a sentinel here is how a routine frame accidentally becomes a
   full-screen redraw.

5. **`fullRepaint()` is serialise-for-attach**, via `@xterm/addon-serialize`.
   ADR 0015 called this the hard part; ADR 0018 verified it round-trips
   byte-identical by writing coloured, cursor-positioned content into a
   headless terminal, serialising, replaying into a second and comparing
   buffers cell by cell: identical, in 143 bytes for content spanning five
   rows; and identical again for a 100×30 alternate-screen TUI with the cursor
   left mid-screen, in 1802 bytes, with cursor position and buffer type
   preserved. A correct-but-dumb full repaint every frame is always a valid
   fallback for `repaintSince`, which is why the encoder can be deferred to
   issue #32: the hard optimisation risks slowness, never wrongness.

6. **Events are parsed in the feed path**, and the list is deliberately short
   and mechanical — every entry corresponds to a real escape sequence or a real
   process event: OSC 0 / OSC 2 title, OSC 7 working directory, BEL / OSC 9 /
   OSC 777 attention, OSC 133 prompt marks (`A` prompt start, `C` command
   start, `D;<code>` command finished), and process exit. There is no
   `agentIsThinking`, because no terminal sequence means that: ADR 0006
   rejected inferring an agent's state from its output. OSC 7 requires shell
   integration the user may not have, so absence is normal and no feature may
   block on it. This layer *reports* attention; whether a signal becomes a
   notification is policy, and policy lives in `@janela/client`, because only
   a client knows what is focused.

7. **`LiveTerminal` lifecycle.** `state` is derived, not stored, and is one of
   `idle` (configured, no process yet), `running`, `needsAttention` (an
   attention signal arrived and the terminal is not focused), `exited {code}`
   (the status is carried so the UI can tell 0 from 130) and
   `failed {message}`. Constructing a `LiveTerminal` costs nothing — no PTY, no
   process, no emulator; `start()` is what allocates, and it is idempotent, so
   calling it on a running terminal is a no-op. That laziness is what makes 40
   configured terminals viable and why `idle` is a first-class state. `stop()`
   is `SIGHUP` to the process group plus PTY teardown; `restart()` keeps the
   terminal's identity and its place in the session's layout. `send()` passes
   bytes to the PTY uninterpreted — Janela implements no key binding the
   terminal should own, and Ctrl-C arrives here as the byte `0x03` for the line
   discipline to interpret. `TerminalRegistry.hangUpAll()` runs on SIGTERM at
   logout and on an explicit "Stop Background Service", and never because a
   client disconnected (non-negotiable #7). `liveCount` is what the daemon's
   idle-exit rule reads: a daemon with live terminals stays even with no
   clients connected, and that asymmetry is the entire feature.

8. **One drain, one feed, N encodes.** `repaintFor(client)` is called once per
   frame per attached client, but the PTY is drained once and the emulator fed
   once regardless of how many clients are attached; only the encode is per
   client. Draining per attached client is the tempting mistake, and it is the
   one that turns two windows into two half-screens.

9. **This package runs in the daemon, never in a client.** It owns the child
   process, so it outlives every window (ADR 0015). The client's half of the
   seam is `TerminalRendering` in `@janela/terminal-ui`, which draws.
   `@janela/terminal` also does not resolve a launch profile or build an
   environment — it receives a fully resolved `TerminalLaunch` from
   `@janela/session`, the only place that knows about projects, profiles and
   the user's shell.

10. **`negotiatedSize` is the minimum of all attached viewports**, which is
    tmux's rule and the only one that guarantees no attached client is shown a
    screen it cannot fit. A client attaching with no viewport — one reading
    text — does not participate. `attach()` returns the resulting PTY size and
    `detach()` returns the new negotiated size, or `undefined` when nobody is
    left attached (ADR 0016).

**Test strategy**:

- A real PTY and a real emulator, no fakes: launch `/bin/echo`, assert the
  event sink reports `exited` with code 0 and that `snapshotText` contains the
  output.
- Feed known ANSI — colours, cursor positioning, alternate screen — and assert
  `snapshotText({ includeScrollback: false })` against the expected screen.
- Feed BEL and assert `onAttention` fires; feed OSC 0 and assert `onTitle`;
  feed OSC 133 `D;1` and assert `onPromptMark` carries `exitCode: 1`.
- Resize and assert *both* halves moved: the emulator's `size` changed and the
  child observed the new dimensions (a `SIGWINCH` handler reporting
  `TIOCGWINSZ`), because a resize that reaches only one of the two is the bug
  this seam exists to prevent.
- The two-emulator round-trip: feed bytes to one emulator, encode the damage
  with `repaintSince`, feed the result to a second, and assert the two grids
  are identical — including a full-screen alternate-screen TUI with the cursor
  left mid-screen. Repeat with `fullRepaint()` as the source, which is the
  attach path.
- `negotiatedSize` with two viewports returns the smaller in each dimension;
  with one viewport returns it unchanged; with none is the "nobody attached"
  case `detach` reports.
- `clearScrollback()` leaves the visible screen untouched, and `revision`
  never decreases across any of the above.

**Seams**:

- `repaintSince` / `repaintFor` / `fullRepaintFor` (issue #32) — damage
  tracking and minimal-sequence encoding; see § 6.1. Implemented as a full
  repaint per changed frame, which is the sanctioned first implementation: the
  optimisation can only make us slow, never wrong. The receiver is reset with
  RIS first, so a repaint is correct onto a populated renderer and not only a
  blank one.
- `createEmulator`, `createLiveTerminal`, `negotiatedSize` and
  `createTerminalRegistry` (issue #21) — done.

---

### 3.2 @janela/session — Project and Session Services

**Status**: Partly implemented. `ProjectService`, `SessionService` and
`resolveShellEnvironment` are done (issue #25), which owns the `createSession`
ordering, the `git worktree add` and the user's first terminal. Two collaborators
are still seams, each injected and called at the step below when present and
skipped when absent: the `.worktreeinclude` copy — `WorktreeIncluding` in
`@janela/git`, and all issue #26 owns — and the automation runner —
`AutomationRunning`, and all issue #27 owns.

**Requirements**: ADR 0009, ADR 0013, ADR 0014 (as amended by ADR 0015), ADR
0015, `docs/domain-model.md` § AutomationCommand, `AGENTS.md` non-negotiable 12.
Layer 5, daemon side (`scripts/layers.ts`).

`@janela/session` is the brain: it composes git, the terminal layer, the
database and the forge into the project and session lifecycle. Its declared
dependencies are `@janela/support`, `@janela/core`, `@janela/git`,
`@janela/db`, `@janela/terminal` and `@janela/forge` — `@janela/protocol` is
absent, and that absence is the layering test. The brain does not know a
socket exists; it announces change through `StateObserving`, an interface it
owns, so it stays usable and testable with no networking at all.

#### ProjectService

From `packages/session/src/project-service.ts`:

```ts
export interface ProjectService {
  readonly projects: readonly Project[];

  load(): Promise<void>;

  find(id: ProjectID): Project | undefined;

  addProject(request: {
    readonly directory: AbsolutePath;
    readonly name?: string;
  }): Promise<Project>;

  removeProject(id: ProjectID): Promise<void>;

  updateSettings(id: ProjectID, settings: ProjectSettings): Promise<void>;
}
```

#### SessionService

From `packages/session/src/session-service.ts`:

```ts
export interface SessionService {
  readonly sessions: readonly Session[];

  load(): Promise<void>;

  find(id: SessionID): Session | undefined;
  inProject(id: ProjectID): readonly Session[];

  readonly standaloneSessions: readonly Session[];

  createSession(request: SessionCreationRequest): Promise<Session>;

  removalPlan(id: SessionID): Promise<SessionRemovalPlan>;

  removeSession(id: SessionID, plan: SessionRemovalPlan): Promise<void>;

  rename(id: SessionID, name: string): Promise<void>;

  startTerminal(id: TerminalID): Promise<void>;
  stopTerminal(id: TerminalID): Promise<void>;
}
```

`createSession` is the single entry point for creation. Worktree creation is
one case of this function, not a separate feature with its own screen; a
second public creation method is the signal that something has gone wrong
(ADR 0009, `docs/product.md` § The thesis).

#### SessionCreationRequest

Five variants, one union, all ending in the same place — a directory with a
name and some terminals:

```ts
export type SessionCreationRequest =
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  | { readonly kind: "inProject"; readonly projectID: ProjectID; readonly name?: string }
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly directory?: AbsolutePath;
      readonly name?: string;
    }
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };
```

#### SessionRemovalPlan

```ts
export interface SessionRemovalPlan {
  readonly liveTerminalCount: number;

  readonly canDeleteDirectory: boolean;

  deletesDirectory: boolean;

  readonly includedPaths: readonly string[];

  readonly runsTeardownAutomation: boolean;

  readonly safety: WorktreeRemovalSafety;
}
```

`deletesDirectory` is the one mutable field in the package: the client sets it
when the user ticks "also delete the worktree", and `removeSession` deletes
files only when `canDeleteDirectory` allows it *and* the caller opted in.
`canDeleteDirectory` is false for a project directory and for an adopted
worktree, always. `includedPaths` exists so the confirmation can name an
`.env` that exists nowhere else instead of asking "are you sure?"; `safety` is
`WorktreeRemovalSafety` from `@janela/git` (§ 1.2), whose
`hasRunningSessions` flag is not git's answer — this package fills it from
the terminal registry, because it is the only place that knows what is live.

There is deliberately **no `RemovalOptions` type and no project-level
`RemovalPlan`**. `ProjectRepository.remove` (`packages/db/src/repositories.ts`)
deletes a project and everything in it — sessions cascade, and their terminals
cascade from those — and its doc comment says outright that it does not ask;
`ProjectService.removeProject` repeats the rule. The removal question is asked
once per session, which is where the directory and the live terminals are, and
`SessionRemovalPlan` is the only shape that carries an answer.

#### AutomationRunning and AutomationReport

`packages/session/src/automation-runner.ts` is a **new** seam and the one
structural change this migration makes to the brain: the automation ordering
previously lived inside `createSession`'s TODO, and splitting it out makes
"run these commands, visibly, in order, and block only for teardown" a
testable unit, which the creation flow around it is not. The split is
recorded in `docs/MIGRATION_MAP.md` so it is not mistaken for a lost seam.

```ts
export interface AutomationRunning {
  run(request: {
    readonly event: AutomationEvent;
    readonly project: Project;
    readonly session: Session;
  }): Promise<AutomationReport>;
}

export interface AutomationReport {
  readonly event: AutomationEvent;
  readonly commands: readonly {
    readonly command: AutomationCommand;
    readonly exitCode?: number;
    readonly timedOut: boolean;
  }[];
}
```

`exitCode` is absent while a command is still running, which is normal for
everything but teardown. `AutomationEvent` is the three-case union in
`@janela/core` (`"worktreeCreated" | "sessionStart" | "sessionTeardown"`); a
fourth event needs an ADR. ADR 0014 writes the events with a leading dot
(`.sessionStart`); the code's strings have none — the code wins.

#### StateObserving

```ts
export interface StateObserving {
  sessionsChanged(sessions: readonly Session[]): Promise<void>;
  projectsChanged(projects: readonly Project[]): Promise<void>;
}
```

`@janela/daemon` implements this and fans out to subscribers; a test
implements it with an array. Neither is visible from here.

#### ShellEnvironment

From `packages/session/src/shell-environment.ts`:

```ts
export interface ShellEnvironment {
  readonly loginShell: string;

  readonly resolved: Readonly<Record<string, string>>;

  loginShellArguments(): readonly string[];
}

export function resolveShellEnvironment(): Promise<ShellEnvironment> {
  // …
}

export function janelaVariables(input: {
  readonly session: Session;
  readonly terminalID: TerminalID;
  readonly projectName?: string;
  readonly automationEvent?: AutomationEvent;
}): Readonly<Record<string, string>> {
  // …
}

export const DECLARED_TERM = "xterm-256color";
```

**Implementation decisions**:

1. **Creation ordering is fixed, documented and depended upon.** Scripts
   break if it moves: a `worktreeCreated` command that runs before the copy
   finds no `.env`.

   ```text
   createSession(request)
     │
     ├─ persist the Session record   ── StateObserving.sessionsChanged
     │                                  visible and selectable from here on
     ├─ git worktree add             ── sessionsChanged
     ├─ .worktreeinclude copy        ── sessionsChanged
     ├─ "worktreeCreated" automation ── sessionsChanged
     ├─ "sessionStart" automation    ── sessionsChanged
     └─ the user's first terminal    ── sessionsChanged
   ```

   Progress is published through `StateObserving` at every step, so the
   session is visible and selectable *before* automation starts — the
   terminal must exist while `pnpm install` is still running. Nothing here
   blocks on a client: the session is persisted and announced before the copy
   and the automation finish, and the client that asked may disconnect
   mid-flight without changing the outcome. The first two steps are skipped
   for `standalone` and `inProject`, and `adoptWorktree` skips only the first.

2. **`addProject` announces first, refreshes git in the background.** Create
   the record, publish `projectsChanged`, then resolve the remote URL, the
   default branch and the forge from the remote host. A user who just picked a
   directory sees the project appear immediately, not after a `git remote -v`
   on a cold NFS mount. Detecting whether the directory is a git repository is
   opportunistic and never blocks — a plain folder is a perfectly good project
   that simply cannot offer worktree-backed sessions.

3. **The client chooses directories; the daemon is handed paths.** `janelad`
   never discovers directories on its own and never scans the home directory.
   That rule is what keeps macOS permission prompts attributed to the app the
   user clicked rather than to a background binary they have never heard of
   (ADR 0017 § TCC attribution).

4. **`load()` is database work only.** No git, no `PATH` probing, no forge
   detection, no process. Those refresh in the background once the daemon is
   serving, because the first client to connect is waiting on this. Restored
   sessions come back **idle**: a configured terminal that has not been
   started costs nothing (`AGENTS.md` non-negotiable 5), and attaching never
   starts anything — `startTerminal` does.

5. **Automation is visible** (`AGENTS.md` non-negotiable 12, ADR 0014). Each
   command for an event runs in order, in its own real terminal with
   `role: { kind: "automation", event }`, in the session's directory, with the
   session's resolved environment — a terminal the user can watch, scroll back
   through and Ctrl-C. Nothing run on the user's behalf happens in a hidden
   process, which is why `AutomationRunning` creates terminals rather than
   capturing output. Commands for one event do not gate each other; there is no
   scheduling, no retry, no dependency graph and no conditional execution.
   `command` is an argv array, never a shell string.

6. **A failure is visible and non-fatal.** A non-zero exit leaves its terminal
   open showing why, the tab marked failed, and the session usable. The only
   thing never done is swallowing it silently. `sessionStart` runs once per
   session — not per app launch, not per client attach — because the daemon
   owns the terminal and `pnpm dev` is very likely still running (ADR 0014 as
   amended by ADR 0015).

7. **`sessionTeardown` is the one blocking case.** `run()` returns once the
   terminals have been *created*, not once the commands have finished, except
   for teardown, where deletion waits — bounded per command by
   `AutomationCommand.timeoutSeconds`, whose schema default is
   `timeoutSeconds Int @default(30)` (`packages/db/prisma/schema.prisma`), and
   past the timeout the user is asked once whether to wait or proceed.
   Deletion never hangs on a script. Teardown **runs to completion even if the
   requesting client disconnects**, and reports to whoever is attached when it
   finishes, or to nobody, which is a supported outcome: a teardown abandoned
   halfway because a window closed would leave exactly the containers and
   databases it exists to clean up.

8. **`.worktreeinclude` is git's matcher and a `clonefile` copy** (ADR 0013);
   this package only sequences it, through `WorktreeIncluding` from
   `@janela/git` (§ 1.2), and records `CopyReport.copied` on
   `WorktreeBinding.includedPaths` so removal can name the files. The ADR's
   2 GB default cap — measure the total first, ask the user once with the real
   number and the offending path, create the session either way — is stated by
   the ADR and **is not carried by the `WorktreeIncluding` interface**, which
   exposes only `resolve`, `copy` and `CopyReport`. Where the cap lands, and
   how the one-time prompt reaches a client that has no request of its own
   outstanding, is issue #26's decision; the number above is the ADR's and is
   not fixed in code.

9. **The login shell is requested with an `argv[0]` `-` prefix.** A daemon
   started by launchd inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so every
   tool installed by Homebrew, mise, nvm or asdf is missing; being a separate
   process does not fix it. The fix is to start a login shell as the
   terminal's process and let the user's own dotfiles build the environment —
   `loginShellArguments()` puts the leading `-` on `argv[0]` because `zsh`
   tests `argv[0][0] === '-'` to decide whether to source `.zprofile`. We
   never parse a `.zshrc`. For the cases where the daemon needs the
   environment itself — checking whether `claude` exists before offering the
   profile — `resolveShellEnvironment()` runs the login shell **once at daemon
   startup**, off the critical path, and caches the result in `resolved`.
   `loginShell` comes from `getpwuid`, falling back to `$SHELL` and then
   `/bin/zsh`; never hardcoded.

10. **`DECLARED_TERM = "xterm-256color"`** on every terminal, rather than a
    bespoke terminfo entry, so every existing tool works on day one. Revisit
    only alongside a shipped terminfo file and ADR 0018 first: the daemon
    emulator and the client renderer must agree on what they claim to be, and
    they are two different libraries now. `janelaVariables` is the whole of
    the `JANELA_*` namespace — the session, its directory, its branch and the
    automation event, so one script can serve several projects. Keep the list
    short: every variable there is one the user cannot control.

11. **`fromPullRequest` resolves the head branch through the forge CLI**, then
    creates a worktree like any other. It never runs `gh pr checkout`, which
    would mutate the user's own checkout (ADR 0012). Forge state is
    opportunistic and never awaited: a missing, logged-out or rate-limited
    `gh` is silence, not an error banner.

12. **The brain announces; it does not deliver.** `StateObserving` is the only
    outbound edge. Nothing in this package or below may import a view layer —
    the daemon detects attention, the client decides what it means, and the
    app delivers it (ADR 0011, enforced by `scripts/layers.ts`).

**Test strategy**:

- `temporaryDatabase()` from `@janela/db` for real migrations and real
  repositories, plus a fake `WorktreeServing`, a fake `AutomationRunning`, a
  `StateObserving` that records into an array, and a fake clock. A test that
  sleeps is a test that flakes; nothing here waits on wall time.
- Every `SessionCreationRequest` variant: `standalone` (no project, no git),
  `inProject`, `newWorktree` with and without `startPoint` and with and
  without an explicit `directory`, `adoptWorktree` (never deletable), and
  `fromPullRequest` against a fake forge that resolves a head branch.
- The ordering guarantee, asserted on the recording observer: the session
  appears in a `sessionsChanged` call **before** the fake
  `AutomationRunning.run` is first entered, and the `.worktreeinclude` copy
  completes before the `worktreeCreated` call.
- A `worktreeCreated` command exiting non-zero: the session still exists, is
  usable, and the automation terminal is still there with its exit code.
- Teardown bounded by its timeout: a command that never exits, a fake clock
  advanced past `timeoutSeconds`, `AutomationReport.commands[0].timedOut`
  true, and removal completing anyway.
- Teardown surviving the asker: `removeSession` runs to completion with no
  observer attached.
- `removalPlan` for a worktree with uncommitted work: `canDeleteDirectory`
  true, `deletesDirectory` false until set, `includedPaths` naming the copied
  `.env`, `runsTeardownAutomation` true when the project has an enabled
  `sessionTeardown` command, and `safety.hasUncommittedChanges` true. The same
  plan for a project-directory session and an adopted worktree has
  `canDeleteDirectory` false.
- `safety.hasRunningSessions` filled from the terminal registry: true while a
  terminal in that directory is live, false once it has exited — the one flag
  git cannot answer.
- `load()` touches nothing but the database: a fake `WorktreeServing` and a
  fake process runner that fail on any call, and `load()` still succeeds with
  every restored session idle.
- `janelaVariables` for a standalone session (no project name) and for an
  automation terminal (event present), asserting the key set rather than
  logging any value (`AGENTS.md` non-negotiable 11).

**Seams**:

- `createSession()` — the ordering above, in
  `packages/session/src/session-service.ts`.
- `addProject()` — announce, then refresh git in the background,
  `packages/session/src/project-service.ts`.
- `AutomationRunning` — implemented over `@janela/terminal`, one
  automation-role terminal per enabled command,
  `packages/session/src/automation-runner.ts`.
- `resolveShellEnvironment()` and `janelaVariables()` —
  `packages/session/src/shell-environment.ts`.

---

### 3.3 @janela/protocol + @janela/daemon — Socket and Message Handling

**Status**: seams. `@janela/protocol` declares the wire vocabulary; every
encoder, decoder and the frame decoder throw `not implemented`.
`@janela/daemon` declares the listener, the server and the frame loop, and
`apps/daemon` is process plumbing with four `TODO:` markers and no body.
Framing and message coding are issue #22, the daemon server and its accept
loop issue #23, `apps/daemon` and the launchd lifecycle issue #24, the
subscription fan-out issue #35, and the LaunchAgent registration and degraded
mode issue #39.

**Requirements**: ADR 0016 (`docs/decisions/0016-daemon-protocol.md`), ADR 0017
(`docs/decisions/0017-daemon-lifecycle.md`), ADR 0020 (rules; reasoning in
0003), `docs/performance.md` § Terminal throughput.

#### Framing

```text
┌────────────┬─────────┬──────────────────────┐
│ length u32 │ kind u8 │ payload              │
│ big-endian │         │ JSON, or raw bytes   │
└────────────┴─────────┴──────────────────────┘
```

`length` counts the payload only; the five header bytes are not included in
it. Frames are length-prefixed rather than delimited because terminal payloads
are arbitrary bytes and there is no byte we could reserve as a separator.

```ts
export interface Frame {
  readonly kind: FrameKind;
  readonly payload: Uint8Array;
}

export const FrameKind = {
  Control: 1,
  Input: 2,
  Output: 3,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export const MAXIMUM_PAYLOAD_LENGTH = 8 * 1024 * 1024;

export const FRAME_HEADER_LENGTH = 5;

export type FrameErrorKind =
  | { readonly kind: "payloadTooLarge"; readonly claimed: number }
  | { readonly kind: "unknownKind"; readonly byte: number }
  | { readonly kind: "truncated"; readonly expected: number; readonly received: number };

export class FrameError extends Error {
  readonly detail: FrameErrorKind;
  constructor(detail: FrameErrorKind) {
    // …
  }
}

export function encodeFrame(frame: Frame): Uint8Array;

export interface FrameDecoder {
  push(chunk: Uint8Array): readonly Frame[];
  readonly pending: number;
}

export function frameDecoder(): FrameDecoder;
```

Code versus spec: the previous specification numbered input `3` and output
`2`. `packages/protocol/src/frame.ts` numbers them `Input: 2` and
`Output: 3`; the code wins.

Three constants carry the framing decisions. `FRAME_HEADER_LENGTH = 5` is the
four-byte big-endian length plus the one-byte kind.
`MAXIMUM_PAYLOAD_LENGTH = 8 * 1024 * 1024` bounds the length prefix, because
an unbounded prefix read off a socket is a memory-exhaustion bug waiting for a
malformed first packet — a full repaint of a very large grid measured well
under 1 MB. `FrameKind` is deliberately tiny: control traffic is rare and
small and pays JSON's cost for readability in logs, terminal traffic is the
hot path and is never encoded at all, and a third high-frequency kind is a
design smell worth an argument first.

Every `FrameErrorKind` is fatal to the *connection* and to nothing else. A
daemon that died because one client sent nonsense would take the user's
terminals with it. `unknownKind` is **not** forward-compatible on purpose: a
peer speaking a kind we do not know has failed the handshake's job.

`FrameDecoder` is stateful because a socket delivers arbitrary chunk
boundaries: a header can arrive split across two reads, and a reader that
assumes otherwise works until the day it does not. `push` returns whatever
complete frames the chunk completed — possibly none, possibly several — and
`pending` is bounded by `MAXIMUM_PAYLOAD_LENGTH`.

#### Handshake

```ts
export interface Hello {
  readonly protocolVersion: number;
  readonly minimumSupported: number;
  readonly clientName: string;
  readonly credential?: Credential;
}

export type Credential = { readonly kind: "bearerToken"; readonly token: string };

export const PROTOCOL_VERSION = 1;

export const MINIMUM_SUPPORTED_VERSION = 1;

export function isCompatible(mine: Hello, other: Hello): boolean;

export type HandshakeRefusal =
  | {
      readonly kind: "incompatibleVersion";
      readonly daemonMinimum: number;
      readonly daemonCurrent: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "protocolViolation" };
```

`PROTOCOL_VERSION = 1` and `MINIMUM_SUPPORTED_VERSION = 1` are equal until
there is a second version to be compatible with. There is no minor version: a
change is either compatible, in which case it needs no number, or it is not.
`clientName` ("Janela.app", "janela-cli") is for logs and for explaining to
the user what is connected, and is never an authorisation input. `credential`
is unused over the local socket, where the operating system vouches for the
peer, and is carried from v1 because adding a field to a shipped protocol is a
breaking change and this one costs nothing.

#### Messages

`ClientMessage` has 14 variants. `hello` and `resize` carry no `id`; the other
twelve carry a `RequestID`.

```ts
export type RequestID = number & { readonly __brand: "RequestID" };

export function nextRequestID(): RequestID;

export type ClientMessage =
  | { readonly type: "hello"; readonly hello: Hello }
  | { readonly type: "subscribe"; readonly id: RequestID; readonly scope: SubscriptionScope }

  // ---- Projects and sessions
  | {
      readonly type: "addProject";
      readonly id: RequestID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly type: "removeProject"; readonly id: RequestID; readonly projectID: ProjectID }
  | {
      readonly type: "updateProjectSettings";
      readonly id: RequestID;
      readonly projectID: ProjectID;
      readonly settings: ProjectSettings;
    }
  | {
      readonly type: "createSession";
      readonly id: RequestID;
      readonly intent: SessionCreationIntent;
    }
  | {
      readonly type: "removeSession";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly deletesDirectory: boolean;
    }
  | {
      readonly type: "renameSession";
      readonly id: RequestID;
      readonly sessionID: SessionID;
      readonly name: string;
    }

  // ---- Terminals
  | {
      readonly type: "attach";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly viewport: GridSize;
    }
  | { readonly type: "detach"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "startTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "stopTerminal"; readonly id: RequestID; readonly terminalID: TerminalID }
  | { readonly type: "resize"; readonly terminalID: TerminalID; readonly size: GridSize }
  | {
      readonly type: "snapshotText";
      readonly id: RequestID;
      readonly terminalID: TerminalID;
      readonly includeScrollback: boolean;
    };
```

Note what is *not* in that union: nothing lets a client read or write the
database, and nothing lets it start a process directly. Every capability is an
intent the daemon validates. If the CLI cannot do it through `ClientMessage`,
neither can the app (ADR 0015 § Rules). `startTerminal` exists because
attaching starts nothing — otherwise opening a session would spawn processes.

`DaemonMessage` has 8 variants.

```ts
export type DaemonMessage =
  | { readonly type: "hello"; readonly hello: Hello }
  | { readonly type: "refused"; readonly refusal: HandshakeRefusal }
  | { readonly type: "state"; readonly update: StateUpdate }
  | { readonly type: "attention"; readonly signal: AttentionSignal }
  | {
      readonly type: "terminalExited";
      readonly terminalID: TerminalID;
      readonly code: number;
    }
  | { readonly type: "acknowledged"; readonly id: RequestID }
  | { readonly type: "failed"; readonly id: RequestID; readonly failure: UserFacingFailure }
  | { readonly type: "text"; readonly id: RequestID; readonly text: string };
```

Keyboard input and terminal output are deliberately **outside** both unions.
They are the two high-frequency messages, they travel as raw frames with a
fixed-width header rather than inside JSON, and keeping them out of the unions
is what stops someone routing them through the control path "just for now".

```ts
export interface TerminalInput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}

export interface TerminalOutput {
  readonly terminalID: TerminalID;
  readonly bytes: Uint8Array;
}
```

```ts
export type SubscriptionScope =
  | { readonly kind: "state" }
  | { readonly kind: "terminal"; readonly terminalID: TerminalID };

export interface StateUpdate {
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;
  readonly isFullSnapshot: boolean;
}
```

`StateUpdate` carries whole objects rather than diffs: the data is kilobytes,
and a diff protocol for the sidebar would be a lot of machinery to save
nothing. All four fields are non-optional, `isFullSnapshot` included — a
client never has to infer whether it is holding the complete picture. Scope
exists so that a CLI listing sessions does not subscribe to terminal output it
will never render.

```ts
export type SessionCreationIntent =
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  | { readonly kind: "inProject"; readonly projectID: ProjectID; readonly name?: string }
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly name?: string;
    }
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };

export interface UserFacingFailure {
  readonly summary: string;
  readonly reason?: string;
  readonly recoverySuggestion?: string;
}

export interface AttentionSignal {
  readonly kind: AttentionKind;
  readonly terminalID: TerminalID;
  readonly sessionID: SessionID;
  readonly id: string;
  readonly occurredAt: Instant;
}

export type AttentionKind =
  | { readonly kind: "bell" }
  | { readonly kind: "notification"; readonly title?: string; readonly body: string }
  | {
      readonly kind: "promptFinished";
      readonly exitCode?: number;
      readonly durationSeconds: number;
    };
```

`SessionCreationIntent` **mirrors** `SessionCreationRequest` in
`@janela/session` rather than sharing it: this one is a serialised intent whose
shape is frozen by the protocol version, and letting an internal type define
the wire format is how a refactor becomes a breaking change for someone's
script. The mirroring is not identity — the wire `newWorktree` has no
`directory?` field, because where a new worktree lands is the daemon's
decision from `ProjectSettings.worktreeRoot`, not the client's.
`AttentionSignal` is a fact, not a decision: policy lives in the client (ADR
0011), and `id` is set by the daemon so two clients can suppress a signal they
have both already delivered.

#### Message coder

```ts
export function encodeClientMessage(message: ClientMessage): Frame;
export function encodeDaemonMessage(message: DaemonMessage): Frame;

export function decodeClientMessage(frame: Frame): ClientMessage;
export function decodeDaemonMessage(frame: Frame): DaemonMessage;

export function encodeInput(input: TerminalInput): Frame;
export function encodeOutput(output: TerminalOutput): Frame;

export function decodeInput(frame: Frame): TerminalInput;
export function decodeOutput(frame: Frame): TerminalOutput;
```

Free functions rather than methods, because the encoding is a property of the
*protocol version*, not of the message: when version 2 encodes control frames
differently, this file is the only place that changes. Control frames are
JSON, for ADR 0016's reason — control traffic is rare and small, and a frame
you can read in a log is worth more than the bytes it costs. A malformed
control frame throws, which closes that connection and nothing else.
`decodeInput` and `decodeOutput` return a **view** into the frame's payload
rather than a copy: they run once per frame per attached client, and a copy
here is a copy on the hot path.

**Raw-frame header seam** (`packages/protocol/src/message-coder.ts`): `Input`
and `Output` frames bypass the JSON path entirely. The header is **16 bytes —
the terminal id's UUID, big-endian, with the payload following immediately**.
Encode it in that one place so both sides agree. Two rejected alternatives,
with the code's reasons:

- Base64 inside JSON would inflate the hot path by a third and add two passes
  per frame.
- A per-connection integer handle would save 12 of those 16 bytes and cost a
  table, a lifecycle and a class of bug where the two sides disagree about
  what handle 3 means. A coalesced repaint measured 140 bytes to a few KB in
  the migration spikes, so a 16-byte header is under 10% at the small end,
  and the UUID is already the thing every other message names.

#### MessageTransport

```ts
export interface MessageTransport {
  incoming(): AsyncIterable<Frame>;
  send(frame: Frame): Promise<void>;
  close(): Promise<void>;
}
```

The one abstraction that makes a remote client possible without redesigning
the protocol, and the only speculative generality the protocol layer allows
itself. In v1 both implementations are local: the daemon's Unix socket
listener, and the desktop app's bridge through Tauri's IPC — a WebView cannot
open a Unix socket, so the Rust shell opens it and relays frames (§ 4.5).
`incoming()` finishes when the peer disconnects cleanly and throws when it
does not; both are ordinary outcomes. `close()` is idempotent. Back-pressure
is the implementation's business and must be bounded.

#### Endpoint

```ts
export const MAXIMUM_SOCKET_PATH_LENGTH = 104;

export function defaultSocketPath(): string;

export const SOCKET_DIRECTORY_MODE = 0o700;

export class SocketPathTooLong extends UserFacingError {
  readonly byteCount: number;
  override readonly summary = "Janela can't create its background service socket.";
  constructor(byteCount: number) {
    // …
  }
}

export interface PeerCredential {
  readonly uid: number;
  readonly pid: number;
}

export function isAuthorized(credential: PeerCredential): boolean;
```

`MAXIMUM_SOCKET_PATH_LENGTH = 104` is the size of `sockaddr_un.sun_path`
measured on macOS 26, and it is why the socket does not live beside the
database in Application Support: that path is already 73 bytes for a
15-character home directory and grows with the username.
`defaultSocketPath()` is `~/.janela/run/janelad.sock`, 40 bytes for a typical
home directory, and throws `SocketPathTooLong` rather than truncating —
a truncated `sun_path` does not error, it silently addresses a *different*
socket. `SOCKET_DIRECTORY_MODE = 0o700` is on the **directory**, not the
socket: the socket is a capability, because anything that can connect can
start processes as this user, and the directory mode is the primary defence
with the peer-uid check second.

#### Daemon server

```ts
export interface DaemonServer extends StateObserving {
  serve(listener: ConnectionListening, signal: AbortSignal): Promise<void>;
  publish(update: StateUpdate): Promise<void>;
  canExitWhenIdle(): boolean;
  readonly connectionCount: number;
}

export interface ConnectionListening {
  accept(): AsyncIterable<AcceptedConnection>;
  close(): Promise<void>;
}

export interface AcceptedConnection {
  readonly transport: MessageTransport;
  readonly credential: PeerCredential;
}

export function createDaemonServer(dependencies: {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly terminals: TerminalRegistry;
}): DaemonServer;
```

`DaemonServer` is thin on purpose: what a message *means* lives in
`@janela/session`, and this package owns connections, subscriptions and the
handshake and nothing else. The test for that is simple — `@janela/session`
must stay usable with no socket at all. `publish` is reached through
`StateObserving`, so the brain never learns that sockets exist. `serve` takes
an already-bound listener, throws only when the *listener itself* fails, and
handles and logs any single connection's failure instead. `canExitWhenIdle()`
is false while any terminal is live, however many clients are connected,
including none; that asymmetry is the entire feature. `connectionCount`
exists for the "what is running" story on version skew. `ConnectionListening`
is an interface so tests drive the server over an in-process pair while
production uses a real socket, and so a future network listener is an
implementation rather than a fork inside `serve`. `@janela/daemon` is the only
package permitted to import `node:net` (`scripts/layers.ts`).

#### Frame loop

```ts
export interface FrameLoop {
  start(signal: AbortSignal): void;
  readonly intervalMs: number;
}

export function createFrameLoop(dependencies: {
  readonly terminals: TerminalRegistry;
  readonly deliver: (client: string, terminalID: string, bytes: Uint8Array) => void;
}): FrameLoop;
```

`intervalMs` is one frame at 120 Hz — 8 ms, the same window as
`COALESCING_WINDOW_MS = 8` in `packages/pty/src/byte-stream.ts`, tuned against
a benchmark rather than argued about. The loop is the daemon's heartbeat: once
per frame, drain every live terminal and send each attached client the repaint
it is owed. It is the shape ADR 0020 requires (rules; reasoning in 0003) —
socket writes coalesced once per frame, per attached client — and the reason a
`yes` flood never reaches a client.

#### Daemon executable

```ts
export function daemonEnvironment(options: {
  readonly databasePath: string;
  readonly foreground: boolean;
}): Promise<{ serve(signal: AbortSignal): Promise<void> }>;
```

`apps/daemon/src/main.ts` is process plumbing only: constructor injection from
one place, no service locator, nothing global — which is also what makes the
whole graph substitutable in `@janela/daemon`'s tests. It ships as one
compiled binary; `bun build --compile` embeds the runtime, the Prisma client,
the emulator and the PTY cdylib (ADR 0020).

**Implementation decisions**:

1. **Handshake first**: nothing is accepted before `Hello`, and a frame that
   arrives before the exchange completes is `refused {protocolViolation}`. An
   incompatible version — no overlap between the two ranges, per
   `isCompatible` — gets `refused {incompatibleVersion, daemonMinimum,
   daemonCurrent}` and a close, so the client can say "the running service is
   older" rather than "handshake failed". **Terminals are never killed on
   version skew.** Refusal does not terminate the daemon, because the
   alternative is an app update killing an agent mid-task; the client explains
   the situation and offers a restart (§ 4.4).
2. **Authentication is the peer uid**: `getsockopt(SOL_LOCAL,
   LOCAL_PEERCRED)`, whose `struct xucred` is 76 bytes on macOS 26 and whose
   `cr_version` must equal `XUCRED_VERSION` before any other field is
   trusted. The uid must equal ours; `LOCAL_PEERPID` is recorded for the log
   only, because a pid is reusable and must never be an authorisation input.
   This is not an escalation boundary — a process running as the user could
   already run anything as the user — it is the boundary that keeps a
   *different* user on a shared Mac out, the same posture as tmux. Note where
   the call runs: `bun:ffi` is gated to `@janela/pty`, so `@janela/daemon`
   cannot call `getsockopt` itself. The listener that owns the descriptor
   obtains the credential from the platform layer and passes it in as
   `AcceptedConnection.credential`, which keeps the system's one FFI surface
   at one. If Bun's socket API grows a peer-credential accessor, use it.
3. **Correlation is a `RequestID` on every mutating message**: replies are
   `acknowledged {id}`, `failed {id, failure}` or `text {id, text}`. `resize`
   and `hello` carry no id — a resize is a fire-and-forget vote and a hello is
   answered by a hello. `state`, `attention`, `terminalExited` and `Output`
   frames are unsolicited. **No request timeout exists in code**; the previous
   specification's 30 s figure is dropped rather than reasserted. The recovery
   path for a lost reply is the reconnect path: the transport's `incoming()`
   finishes, the client asks for a new transport, re-subscribes and receives a
   full snapshot (§ 4.1).
4. **Subscription**: `subscribe {scope: {kind: "state"}}` yields exactly one
   `state` with `isFullSnapshot: true`, then partial updates as things change.
   The same sequence happens again after any reconnection, so a client's
   recovery story and its startup story are one code path.
5. **Attach**: `fullRepaintFor(client)` once — which is what makes reattaching
   correct rather than lucky — then one `Output` frame per frame per client
   from `repaintFor(client)`. The PTY is sized to the **minimum of all
   attached viewports** (ADR 0016): two clients may have different window
   sizes and the PTY has exactly one `TIOCSWINSZ`, and the minimum is tmux's
   rule and the only one that guarantees no attached client is shown a screen
   it cannot fit. A client attaching with no viewport — the CLI, reading text
   — does not participate. `detach` stops that client's output only, and
   nothing else about the terminal changes.
6. **Fan-out is per subscriber, with two policies**: each subscriber has its
   own `BoundedQueue` from `@janela/support` (`packages/support/src/bounded.ts`)
   and a stalled client must not slow the others. The policies are a
   correctness decision, not a tuning one: coalesced repaints use
   `dropOldest`, because a newer frame supersedes an older one and the next
   full repaint recovers anything lost; control frames and terminal input use
   `block` and **drop nothing, ever**, because a dropped keystroke is data
   loss the user can see. A dropped raw byte would truncate an escape sequence
   and desynchronise the parser, which is a corruption with a delay rather
   than a recovery. A bad handshake, a malformed frame or a peer crash never
   takes down the daemon or another connection.
7. **The frame loop touches nothing per byte**: one drain per terminal per
   frame, N encodes, and counters and buffer views for the rest. Draining per
   attached client would multiply the work by the number of windows. ADR 0020's
   measurements are the evidence this shape works: **133 MB/s** sustained off
   the PTY under a `yes` flood against a ≥ 100 MB/s budget, memory growth
   with the consumer stalled bounded at **~4 MB** then flat, and — the figure
   that mattered most, because it is the property a single-threaded daemon
   puts at risk — an 8 ms timer firing within **1.7 ms** of its deadline
   throughout, with a second terminal staying interactive. A 133 MB/s flood
   therefore becomes a bounded number of frames per second on the socket.
8. **Lifecycle** (ADR 0017): the daemon is socket-activated by launchd, which
   declares the socket in the plist. **Obtain the listening descriptor from
   launchd; never bind a path in production** — launchd created the socket,
   owns its lifetime, and starting us was its decision, so binding our own
   would race with it. `--foreground` is the one case where no launchd job
   exists and falls back to `defaultSocketPath()`. `launch_activate_socket` is
   the one seam the migration made harder: it is a C function and `bun:ffi` is
   gated to `@janela/pty`. The expected route is one more export on the PTY
   cdylib, `janela_launch_socket()`, handing Bun the descriptor as a plain
   integer — one native artifact, already built and signed. The alternative —
   bind the path ourselves and drop socket activation, so the daemon is
   started by the app rather than by launchd — trades away the "a user who
   never opens Janela never has a process" property that ADR 0017 chose
   deliberately, and **must not be taken silently**; whichever route is taken
   is written down. SIGTERM (launchd at logout) and SIGINT (a foreground
   developer run) both run `TerminalRegistry.hangUpAll()` **before** exiting,
   so children get SIGHUP rather than being reparented onto launchd; SIGPIPE
   is ignored, because a client vanishing mid-write is routine. Idle exit
   happens only after the last client disconnects with no live terminal, and
   only after a grace period of **5 minutes** per ADR 0017's table, so
   quitting and reopening the app does not tear down and rebuild the world —
   no constant for it exists in code yet, and when one lands it wins. A
   daemon holding live terminals never exits on its own. Startup is: build the
   object graph (`daemonEnvironment()`) → open the database → run migrations →
   restore sessions **idle** → serve until cancelled. Migration failure is
   the interesting error, because the only way a user learns about it is a
   client that cannot connect: log it clearly and exit non-zero so launchd's
   `KeepAlive` does not spin.

**Test strategy**:

- We do not fake the socket. Tests bind a real Unix socket inside a
  `temporaryDirectory()` from `@janela/test-support`, and the path must be
  **short**: `sun_path` is 104 bytes, so a test that builds its own long path
  passes for you and fails for the next person, whose home directory is
  longer.
- Handshake accepted: matching versions produce `hello` and a usable
  connection.
- Version skew refused, terminals unaffected: a client advertising an
  incompatible version gets `refused {incompatibleVersion}` and a close, and
  the terminal it was going to attach to still has the same pid and an intact
  screen afterwards.
- A connection whose credential carries a uid other than ours is rejected.
- `subscribe {scope: state}` yields one `state` with `isFullSnapshot: true`.
- `attach` yields a full repaint first, then per-frame output.
- Input round-trips: bytes written to a terminal running `cat` come back as
  output.
- Two clients attached with different viewports: the PTY is sized to the
  smaller one, and the larger client is not shown a screen it cannot fit.
- A frame split across two `recv`s decodes as one frame, including a header
  split mid-length-prefix.
- A length prefix that lies: one over `MAXIMUM_PAYLOAD_LENGTH` raises
  `payloadTooLarge` and closes only that connection; a peer that vanishes
  mid-payload raises `truncated`.
- A stalled client — one that never reads — leaves the daemon and every other
  connection unaffected: its repaint queue sheds oldest, its input queue does
  not, and the other client's frame rate does not move.
- Idle exit with a fake clock: `canExitWhenIdle()` is false while a terminal
  is live regardless of connection count, true once the last client
  disconnects with none live, and the exit happens only after the grace
  period.

**Seams**:

- `frameDecoder()`, `encodeFrame` and the six coder functions in
  `packages/protocol/src/message-coder.ts`, including the 16-byte raw header
  described above (issue #22).
- `isCompatible` and `nextRequestID` (issue #22).
- `defaultSocketPath()` and `isAuthorized()` in
  `packages/daemon/src/endpoint.ts` (issue #23).
- `createDaemonServer()`, its accept loop and its fan-out (issues #23, #35).
- `createFrameLoop()` (issue #23).
- `daemonEnvironment()` and the four `TODO:` blocks in `apps/daemon/src/main.ts`
  — signals, socket activation, idle exit and startup ordering (issue #24),
  with LaunchAgent registration and the degraded mode that follows from it
  owned by issue #39 and described in § 4.5.

---

## IV. Client-Side Implementation

### 4.1 @janela/client — Connection, Mirror and Attention Policy

**Status**: seams. `@janela/client` is layer 6 on the client side
(`scripts/layers.ts`); the connection, the stores and the attention policy exist
as interfaces with `TODO:` bodies (`createConnection`, `createStores` and
`createAttentionPolicy` all throw `not implemented`). Issue #28 owns the
connection and the stores; issue #36 owns delivery in the app.

**Requirements**: ADR 0015 (the daemon is the truth, this is a mirror), ADR 0011
(policy in the client, delivery in the app), ADR 0023 (transport-agnostic so a
browser client is a transport), ADR 0020 (rules; reasoning in 0003), ADR 0006
(where a signal may come from). `docs/performance.md` § Launch.

#### DaemonConnection

```ts
export interface DaemonConnection {
  readonly status: ConnectionStatus;

  readonly isStale: boolean;

  connect(): Promise<void>;

  request(message: ClientMessage): Promise<void>;

  sendInput(bytes: Uint8Array, terminalID: TerminalID): void;

  onOutput(terminalID: TerminalID, handler: (bytes: Uint8Array) => void): () => void;

  disconnect(): Promise<void>;
}

export type ConnectionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "refused"; readonly refusal: HandshakeRefusal };

export function createConnection(options: {
  readonly transport: MessageTransport;
  readonly clientName: string;
}): DaemonConnection;
```

#### ProjectStore, SessionStore and MirrorApplying

```ts
export interface ProjectStore {
  readonly projects: readonly Project[];
  find(id: ProjectID): Project | undefined;
  subscribe(listener: () => void): () => void;
}

export interface SessionStore {
  readonly sessions: readonly Session[];

  selection: SessionID | undefined;

  readonly terminalStates: Readonly<Record<TerminalID, TerminalState>>;

  inProject(id: ProjectID): readonly Session[];
  readonly standaloneSessions: readonly Session[];

  isRunning(id: SessionID): boolean;

  subscribe(listener: () => void): () => void;
}

export interface MirrorApplying {
  apply(update: StateUpdate): void;
  markStale(): void;
}

export function createStores(): {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly mirror: MirrorApplying;
};
```

#### AttentionPolicy and AttentionDelivering

```ts
export interface AttentionPolicy {
  shouldDeliver(signal: AttentionSignal, context: AttentionContext): boolean;

  forgetSession(id: SessionID): void;
}

export interface AttentionContext {
  readonly isApplicationActive: boolean;
  readonly selectedSessionID?: SessionID;
  readonly focusedTerminalID?: TerminalID;
}

export const COALESCING_WINDOW_SECONDS = 5;

export const LONG_RUNNING_THRESHOLD_SECONDS = 10;

export function createAttentionPolicy(): AttentionPolicy;

export interface AttentionDelivering {
  deliver(input: {
    readonly signal: AttentionSignal;
    readonly sessionName: string;
    readonly terminalTitle: string;
  }): Promise<void>;

  withdraw(sessionID: SessionID): Promise<void>;
}
```

**Implementation decisions**:

1. **Ownership survives, isolation does not**: the thread-isolation annotation
   the previous spec relied on is gone, because a WebView has one thread and the
   client is single-threaded. The *ownership* rule that annotation protected is
   unchanged and is the part that mattered: `sessions`, `projects` and
   `terminalStates` are the daemon's and change only through
   `MirrorApplying.apply`. `selection` is purely local — never sent to the
   daemon, never received from it — because two clients attached to one daemon
   are meant to look at different sessions. There is no other local mutation
   path: "collapse this project" is a request, and the collapse renders when the
   daemon confirms it.
2. **Transport-agnostic**: the package takes a `MessageTransport` and imports no
   Tauri, no DOM and no React. A browser client is a new transport, not a new
   client (ADR 0023).
3. **Connect sequence**: `Hello` → the daemon's `hello` or `refused` →
   `isCompatible` → `subscribe {scope: "state"}` → pump incoming frames into the
   stores. `connect()` is never called on the launch path in a way that blocks
   first paint: the window draws its empty or last-known state and fills in when
   the connection resolves.
4. **Reconnection is one timer, and it lives here**: the Rust shell owns the
   socket and performs the connect; `MessageTransport.incoming()` finishes when
   the shell reports the connection ended. The client decides *when* to ask for
   a new transport, counts `attempt` into `reconnecting`, and re-subscribes —
   which replaces the mirror with a full snapshot rather than merging into it,
   and re-attaches for a fresh full repaint, which is why recovery needs no
   special case. `refused` is terminal until the user acts; it is almost always
   a version mismatch after an app update, and an automatic daemon restart would
   kill live terminals. **The backoff schedule is not fixed in code** — no
   constant exists — and issue #28 sets it; the previous spec's 1 s doubling to
   a 30 s cap is not normative.
5. **Merge rules**: a full snapshot replaces; a partial update merges by id and
   preserves order, because a partial update names only what changed.
   `selection` survives a partial update in which the selected session is
   absent — it may simply not have changed. It is cleared only when a full
   snapshot proves the session gone, and then a neighbour is selected rather
   than nothing: dropping the user into an empty detail pane because a
   *different* session was deleted is a bug they notice.
6. **Stale state is rendered, not discarded**: disconnection is normal — the
   daemon may be restarting, upgrading or briefly gone. Views keep rendering the
   last mirror with `isStale` set and `markStale()` called on disconnect.
   Nothing blocks on the socket, and terminals are unaffected either way because
   they live in the daemon.
7. **Attention rules, as the code states them** (`attention-policy.ts`), in
   order: already delivered → no, so two windows do not double-notify; the
   application active *and* the session selected *and* the terminal focused →
   no, the user is looking straight at it; a bare BEL → badge, do not interrupt;
   an OSC 9 / OSC 777 notification → deliver, because the program asked for a
   notification by name and that is consent; a finished prompt → deliver only
   when it failed *and* ran longer than `LONG_RUNNING_THRESHOLD_SECONDS`. The
   in-app badge and pane indicator update **regardless** of what
   `shouldDeliver` returns — the sidebar is the primary channel and it needs no
   permission. Signals coalesce per terminal over `COALESCING_WINDOW_SECONDS`,
   delivered entries expire past that window, and `forgetSession` clears a
   session's entries when it is removed. `AttentionSignal.id` is stamped by the
   daemon so two attached clients suppress a duplicate.
   ADR 0011 says notify "only when Janela is not frontmost, or the signalling
   terminal is in a session that is not selected", and makes a bare BEL deliver
   when the user opted into "notify on bell"; the code's rule is narrower (all
   three of active, selected and focused must hold to suppress) and has no
   opt-in switch. The code wins; ADR 0011 needs an amendment, which is not in
   this issue's scope.
8. **Delivery is the `AttentionDelivering` seam**, implemented in `apps/desktop`
   over `@tauri-apps/plugin-notification`, because that is an app-level
   capability and this package must stay testable — and browser-reachable —
   without one. Title is the session name, subtitle the terminal title, body the
   OSC payload when there is one. The body is never logged, never included in an
   error report and never persisted (non-negotiable #11). Authorization is
   requested lazily on the first delivery that would otherwise occur, not at
   launch, and is requested by the app and never by `janelad`; denial is a
   supported state in which the in-app badge is unaffected and we never ask
   twice.

**Retirements**:

- The previous spec's client-side terminal mirror type is gone: its state is
  split across `SessionStore.terminalStates` (what the daemon last reported),
  `DaemonConnection.sendInput` / `onOutput` (the byte path for an attached
  terminal) and `TerminalRendering` in `@janela/terminal-ui` (the screen).
- The previous spec's connection-manager type is now `DaemonConnection`, with
  the reconnect timer and the `attempt` counter kept here rather than in the
  shell that owns the socket.

**Test strategy**:

- An in-memory `MessageTransport` is the one place the transport is faked: the
  daemon side is tested over a real socket, so the pairing of the two is covered
  there and faking it here buys speed without buying a false pass.
- Reconnect with the daemon killed mid-frame: a half-read frame on the old
  connection must not corrupt the new one, and re-subscribing must produce a
  full snapshot that replaces the mirror.
- Merge by id preserving order; `selection` kept across a partial update that
  omits the selected session; a full snapshot proving it gone selects a
  neighbour.
- Version skew from the daemon lands in `refused` and is not retried; terminals
  are untouched.
- A recording `AttentionDelivering` and a fake clock: four bells inside
  `COALESCING_WINDOW_SECONDS` deliver once; the focused-and-frontmost case
  delivers nothing while the badge still updates; OSC 9 always delivers; a
  failed prompt at 2 s does not deliver and the same prompt at 15 s does.
- `forgetSession` drops pending entries, and no delivery survives for a session
  that no longer exists.

---

### 4.2 @janela/design — Tokens and Reusable Controls

**Status**: the tokens exist in `packages/design/src/tokens.ts`. `grid()` and
the control set are a new seam with no tracking issue — the previous design
package held tokens and a colour catalog, and its controls were never written.
Layer 7, client side (`scripts/layers.ts`).

**Requirements**: `docs/product.md` § Principles 4, ADR 0023, ADR 0024.

#### Tokens

```ts
export const GRID_UNIT = 4;

export function grid(multiple: number): string {
  // …
}

export const SIDEBAR_WIDTH = { minimum: 180, ideal: 240, maximum: 400 } as const;

export const CORNER_RADIUS = { small: 6, medium: 10 } as const;

export const TERMINAL_INSETS = { top: 8, leading: 10, bottom: 8, trailing: 6 } as const;

export const COLOR = {
  terminalBackground: "--janela-terminal-background",
  attention: "--janela-attention",
  running: "--janela-running",
  failure: "--janela-failure",
} as const;

export const TERMINAL_FONT_STACK =
  '"SF Mono", "Menlo", "DejaVu Sans Mono", ui-monospace, monospace';

export const MOTION = { fast: 120, medium: 200 } as const;
```

**Implementation decisions**:

1. **Colours are CSS custom properties, resolved by the platform**: each of the
   four names in `COLOR` is defined once in `tokens.css` for light, dark and
   increased contrast, and resolved by `prefers-color-scheme` and
   `prefers-contrast`. **No component branches on appearance** — that rule is
   why this is one token file rather than two palettes, and it is unchanged from
   the asset catalog it replaces (ADR 0023).
2. **Colours are semantic, never literal**: there is no `janela.blue`, because
   such a name says nothing about when to use it and guarantees drift. The bar
   for a new token: used in at least two places, or it encodes a decision
   someone would otherwise get wrong. Everything else is a literal at the call
   site.
3. **Icons are `lucide-react`**: the dependency is declared in
   `packages/design/package.json`. An unknown `iconName` — the field
   `LaunchProfile` carries — falls back to a default glyph rather than
   rendering nothing, because a profile row with an invisible icon looks like a
   layout bug.
4. **SF Mono first, in a user-overridable stack**: `TERMINAL_FONT_STACK` is the
   default only, overridable in Settings. SF Mono ships with macOS, has the
   coverage agents need and hints well at small sizes; the fallbacks exist
   because a WebView on another platform has to render something.
5. **Every transition respects `prefers-reduced-motion`**, the web's spelling of
   the Reduce Motion setting `docs/product.md` § Principles 4 commits to. A
   component that animates unconditionally is a bug, not a flourish. `MOTION`
   carries the only two durations, in milliseconds: fast 120, medium 200.
6. **The control set is closed**: `Button`, `IconButton`, `Sheet`,
   `DisclosureGroup`, `StatusDot`, `Field`, `Segmented`, `ContextMenu`,
   `Tooltip`, `EmptyState`, as shadcn/ui-derived components over the tokens
   above. A design package that grows a component per screen has become the UI
   package. Two rules for every one of them: keyboard-reachable with a visible
   focus ring — anything reachable only by mouse is a feature we have
   half-shipped — and **no `Ctrl`-based key handling anywhere**, because `Ctrl`
   belongs to the program running in the terminal and a control that swallows it
   breaks that program.
7. **`@janela/core` is deliberately absent from the dependencies**: the only
   first-party edge is `@janela/support` (`scripts/layers.ts`). It knows
   nothing about projects or sessions and could be lifted into another app; that
   constraint is what stops a token from coming to depend on a domain type, and
   what keeps this a design system rather than a pile of Janela views.

**Test strategy**:

- Presentation logic only, and there is very little of it: `grid()` is the one
  function with an assertion worth making.
- No snapshot tests (`docs/testing.md` § UI): they fail on OS updates for
  reasons unrelated to correctness.

**Seams**:

- `packages/design/src/index.ts` — the ten controls above, with the two rules,
  as a `TODO:`. Nothing names them yet, so nothing above may assume a prop
  shape.
- `grid()` in `tokens.ts` — `TODO:` returns the CSS length for a multiple of
  `GRID_UNIT`.

---

### 4.3 @janela/terminal-ui — Terminal Surface Rendering

**Status**: seam, issue #29. `TerminalRendering` is defined; `TerminalSurface`
is a `TODO:` in `packages/terminal-ui/src/index.ts` and has no prop shape yet.
Layer 8, client side (`scripts/layers.ts`; the package's own header comment says
layer 7 — `scripts/layers.ts` declares itself the single source of truth for the
graph, so 8 is the number).

**Requirements**: ADR 0018, ADR 0016.

#### TerminalRendering

```ts
export interface TerminalRendering {
  feed(bytes: Uint8Array): void;

  readonly viewport: GridSize;

  onViewportChange: ((size: GridSize) => void) | undefined;

  onInput: ((bytes: Uint8Array) => void) | undefined;

  selectedText(): string | undefined;

  clearViewport(): void;

  dispose(): void;
}
```

`GridSize` is imported from `@janela/core`. That is the whole exported surface
of the package today; `TerminalSurface` — a React component wrapping the
renderer and conforming to `TerminalRendering` — is the seam issue #29 fills.
**TODO:** define its props once the composition root in § 4.5 knows what it
hands down.

**Implementation decisions**:

1. **Backed by `@xterm/xterm`**: the second and last package allowed to name a
   terminal library. `@janela/terminal` owns the daemon-side grid; this owns
   fonts, painting, selection and keyboard. The two-seams rule survives a total
   change of language (ADR 0018; reasoning in 0004); what changed is that it is
   now *enforced* rather than reviewed — `GATED_MODULES` in `scripts/layers.ts`
   allows `@xterm/xterm` to `@janela/terminal-ui` alone, and `@xterm/addon-*` to
   the two seam packages only.
2. **A renderer can stay this simple because it is fed escape sequences**,
   exactly as a real terminal is fed them from a PTY. The daemon holds the grid,
   tracks damage and emits the shortest sequence that repaints what changed, so
   this type needs no grid diff, no custom wire format and no knowledge that a
   daemon exists — which is also why a browser client needs no adaptation here.
3. **Fed imperatively through a ref; terminal bytes never enter React state.** A
   component that puts output in state re-renders React 60 times a second and
   turns the cheapest path in the client into the most expensive one.
4. **It must not own a PTY.** The library will happily start a process; that is
   the daemon's job (ADR 0015). The layering gate stops the import of
   `@janela/pty`, but nothing stops a `spawn` option — so do not pass one.
5. **It must not interpret input.** Bytes, not a string: a surface that hands up
   decoded text has already lost the distinction between a paste of invalid
   UTF-8 and a paste of replacement characters. Janela binds no key the terminal
   should own, which is why splits and tabs use `⌘` chords (§ 4.4).
6. **The viewport is a vote, not a command.** It is reported in *cells*, derived
   from measured cell metrics, and sent to the daemon on attach and on resize;
   the daemon sizes the PTY to the *smallest* attached viewport (ADR 0016).
7. **Resizes are coalesced to one per frame during a divider drag.** Each one is
   a `TIOCSWINSZ` plus a `SIGWINCH` plus a full reflow, on the dragged terminal
   and on its neighbour, across two process boundaries; an uncoalesced drag
   sends one per mouse move. `docs/performance.md` § Interaction budgets a
   reflow at one frame.
8. **Selection is client-side.** Two clients attached to one terminal select
   independently, because a selection is something a person is doing, not a
   property of the process. `clearViewport()` clears the local view and never
   touches the daemon's scrollback — that is `clearScrollback` in § 4.4, which
   travels as a message.

This section replaces the previous spec's platform view wrapper: there is no
host-view bridge left to describe, because the surface is a React component in a
WebView.

**Test strategy**:

- Manual against a real daemon, which is where a renderer is actually judged:
  feed known sequences and look, then type into `cat` and confirm the bytes come
  back.
- The ADR 0018 variant round-trip — daemon emulator → repaint encode → *client*
  renderer, asserting the client's grid matches the daemon's — is the test worth
  writing before v1. ADR 0018 § Consequences is explicit that "they cannot
  disagree because they are the same code" has become "they should not
  disagree", and this test is the whole mitigation.
- No snapshot tests (`docs/testing.md` § UI).

**Seams**:

- `packages/terminal-ui/src/index.ts` — `TerminalSurface`, with the three things
  it must not do.

---

### 4.4 @janela/ui — Views and Navigation

**Status**: seams; issues #29 (the terminal surface it composes), #37 (the
command surface) and #38. Every view in the package currently throws
`not implemented`. Layer 9, client side (`scripts/layers.ts`; the package's own
header comment says layer 8 — the graph file wins).

**Requirements**: ADR 0009, ADR 0010, ADR 0024, `docs/product.md` § Principles
1 and 3.

#### View hierarchy

```text
MainWindow                        the entire application
├── Sidebar                       two levels, and never a third
│   ├── (unlabelled section)      standalone sessions, no project
│   └── DisclosureGroup × project bound to `Project.isExpanded`
│       └── session button        status from `SessionStore.terminalStates`
├── SessionDetail(sessionID)
│   ├── tab strip                 over `session.layout.tabs`
│   └── pane view                 recursive over `Pane`, draggable dividers
│       └── TerminalSurface       one per terminal pane (§ 4.3)
└── ConnectionBanner              inset strip, only when the daemon is silent
```

There is no inspector, no bottom panel and no activity bar; adding one requires
an argument that survives `docs/product.md` § Non-goals. The sidebar is
deliberately **a flat list of buttons, not a recursive tree component**: ADR
0009 fixes the shape at two levels, and a recursive view would quietly permit
the third. What the window is looking at is a *mirror* — the sessions live in
`janelad` and the stores hold the last state it sent (ADR 0015).

#### Exports

```ts
export function MainWindow(): ReactElement;

export function Sidebar(): ReactElement;

export function SessionDetail(props: { readonly sessionID: string }): ReactElement;

export function ConnectionBanner(): ReactElement | null;

export interface Command {
  readonly id: CommandID;
  readonly title: string;
  readonly accelerator?: string;
}

export type CommandID =
  | "newSession"
  | "newTerminal"
  | "openFolder"
  | "addProject"
  | "goToSession"
  | "newBranchSession"
  | "nextSession"
  | "previousSession"
  | "revealInFinder"
  | "openInTerminal"
  | "splitRight"
  | "splitDown"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "restartTerminal"
  | "clearScrollback";

export const COMMANDS: readonly Command[];
```

#### Keyboard

`COMMANDS`, in file order, from `packages/ui/src/commands.ts`. Eighteen
commands; sixteen accelerators, written in Tauri's notation because the native
menu bar in `apps/desktop/src-tauri` is built from this table (ADR 0024).

| Command id          | Title                | Accelerator            |
| ------------------- | -------------------- | ---------------------- |
| `newSession`        | New Session          | `CmdOrCtrl+N`          |
| `newTerminal`       | New Terminal         | `CmdOrCtrl+T`          |
| `openFolder`        | Open Folder…         | `CmdOrCtrl+O`          |
| `addProject`        | Add Project…         | `CmdOrCtrl+Alt+O`      |
| `goToSession`       | Go to Session…       | `CmdOrCtrl+Shift+O`    |
| `newBranchSession`  | New Branch Session…  | `CmdOrCtrl+Shift+B`    |
| `nextSession`       | Next Session         | `CmdOrCtrl+Shift+]`    |
| `previousSession`   | Previous Session     | `CmdOrCtrl+Shift+[`    |
| `revealInFinder`    | Reveal in Finder     | —                      |
| `openInTerminal`    | Open in Terminal     | —                      |
| `splitRight`        | Split Right          | `CmdOrCtrl+D`          |
| `splitDown`         | Split Down           | `CmdOrCtrl+Shift+D`    |
| `focusPaneLeft`     | Focus Pane Left      | `CmdOrCtrl+Alt+Left`   |
| `focusPaneRight`    | Focus Pane Right     | `CmdOrCtrl+Alt+Right`  |
| `focusPaneUp`       | Focus Pane Up        | `CmdOrCtrl+Alt+Up`     |
| `focusPaneDown`     | Focus Pane Down      | `CmdOrCtrl+Alt+Down`   |
| `restartTerminal`   | Restart Terminal     | `CmdOrCtrl+Shift+R`    |
| `clearScrollback`   | Clear Scrollback     | `CmdOrCtrl+Shift+K`    |

**No `Ctrl` chord is bound anywhere**, and no key is intercepted before the
terminal sees it: `Ctrl`-anything belongs to the running program, `Ctrl-b` and
`Ctrl-a` belong to tmux and screen, and a user running either inside Janela must
not have to think about which layer ate their keystroke. That is why splits,
tabs and pane focus are `⌘`-based, and why pane focus is `⌘⌥`-arrow rather than
a plain arrow. `⌘⇧O` is the one shortcut worth spending: it is how you get
anywhere without touching the sidebar. There is no configurable binding surface.
On macOS — the only platform v1 ships (ADR 0023) — `CmdOrCtrl` resolves to `⌘`;
a non-macOS build would resolve it to `Ctrl`, which the rule above forbids, so
that build needs a per-platform accelerator table. Issue #37 owns it.

*Code versus ADR*: ADR 0010 § Keyboard lists `⌘W` to close a pane, `⌘T` for a
new tab and `⌘⇧[` / `⌘⇧]` for tabs. The `COMMANDS` table has no close-pane
command and no tab commands at all, `⌘T` is New Terminal, and `⌘⇧[` / `⌘⇧]`
switch sessions. The table is authoritative and ADR 0010's chord list is stale;
issue #37 owns the command surface, and the amendment is not in this document's
scope.

**Implementation decisions**:

1. **Expanding a project does no work.** `Project.isExpanded` is a boolean on a
   record. If expanding ever needs to read git, load sessions or refresh
   anything, the laziness rule (`docs/product.md` § Principles 6) has been
   broken upstream, not here.
2. **Session status is derived only from `SessionStore.terminalStates`** — what
   the daemon reported. Never inferred locally; a second derivation is a second
   source of truth that disagrees under load.
3. **The fuzzy jump list (`⌘⇧O`) lives in the sidebar.** With forty sessions the
   sidebar is long by design, and the jump list is what keeps "every session is
   one keystroke away" true at that size.
4. **Attaching a pane shows a full repaint, with no loading state.** `attach`
   is answered by a full repaint (§ 3.3), so there is no separate "load
   scrollback" step and no spinner to design.
5. **Divider drags coalesce to one resize per frame**, per § 4.3. The previous
   spec's fixed millisecond delay on resize is gone: the budget is a frame, and
   a timer that is not the frame is either slower than the budget or busier.
6. **The connection banner is an inset strip, never a modal**, and it must not
   shift the layout when it appears — a terminal that jumps a few pixels every
   time the daemon restarts is worse than no banner. `connecting` and
   `reconnecting` are routine and usually resolve within a frame or two of the
   daemon restarting, so they get a thin, quiet strip. Blocking the window would
   be a lie about how bad the situation is: the terminals are still running and
   their state is still on screen.
7. **The `refused` case is the version-skew story**, and it needs a sentence and
   a button. It says what is still running — "3 sessions, 2 with live terminals"
   — and that restarting will close it, then lets the user choose. The copy is
   settled and is used as written:

   ```text
   Janela was updated. The background service is still running your terminals
   on the previous version. Restart it when you are ready — this will close your
   terminals.
   ```

8. **The daemon is never restarted automatically.** It is holding live work, and
   an app update killing an agent mid-task is the exact failure ADR 0017 §
   Version skew exists to prevent.
9. **The client cannot spawn a process.** Absent from this package's
   dependencies: git, the PTY package, the database and the daemon-side
   services. The capability is not discouraged, it is not present, and
   `scripts/layers.ts` makes that structural — `@janela/ui` may reach
   `@janela/core`, `@janela/protocol`, `@janela/client`, `@janela/design` and
   `@janela/terminal-ui`, and no further. A view that wants a fact the mirror
   does not carry needs a protocol message, not a shortcut.

**Test strategy**:

- Presentation logic only, and where a view has logic worth testing that logic
  belongs in a store where it can be tested directly (§ 4.1). No snapshot tests
  (`docs/testing.md` § UI).
- Manual against a real daemon for everything else: the sidebar's two levels,
  status dots, a divider drag, and a `bun run daemon:restart` to see the banner
  appear and the mirror re-fill.

**Seams**:

- `packages/ui/src/main-window.tsx` — `MainWindow`, `Sidebar` and
  `SessionDetail`, plus the `TODO:` notes that carry the sidebar and pane rules
  above.
- `packages/ui/src/connection-banner.tsx` — the `connecting`/`reconnecting`
  strip and the `refused` case with the copy above.

---

### 4.5 apps/desktop — Composition Root, Tauri Shell and IPC Bridge

**Status**: seams. `AppEnvironment` and `tauriTransport()` are declared and
throw `not implemented`; `apps/desktop/src-tauri/src/main.rs` is a
`fn main() {}` under a closed list of responsibilities. Issue #30 owns the
bridge, the window and the native menu; issue #36 owns attention delivery inside
the app; issue #39 owns launch-agent registration and the degraded mode; issue
#41 owns the build deliverables listed below.

**Requirements**: ADR 0024, ADR 0017 (amended by ADR 0020 — registration happens
from the Tauri shell), ADR 0011 (amended by ADR 0015 — the daemon detects, the
client decides, the app delivers), ADR 0008 (amended by ADR 0024 and ADR 0015 —
two signed executables), ADR 0023 § keystroke path, and `docs/performance.md`
§ Launch.

#### AppEnvironment

```ts
export interface AppEnvironment {
  readonly projects: ProjectStore;
  readonly sessions: SessionStore;
  readonly connection: DaemonConnection;
  readonly attention: AttentionDelivering;

  start(): Promise<void>;
}

export function liveEnvironment(): AppEnvironment;
```

#### tauriTransport

```ts
export function tauriTransport(): MessageTransport;
```

#### Web entry point

```ts
// apps/desktop/src/main.tsx
export const ROOT_ELEMENT_ID = "janela-root";
```

The sink is installed here, once, from `@janela/support`:

```ts
export interface LogSink {
  write(record: LogRecord): void;
}

export function setLogSink(sink: LogSink): void;
```

**Implementation decisions**:

1. **The composition root opens no database.** The previous specification gave
   `AppEnvironment` a `database` field and opened the database on the launch
   path; both are deleted. `janelad` is the exclusive owner of the database
   (ADR 0015, ADR 0019), and the app could not open one if it tried:
   its declared dependencies are `@janela/support`, `@janela/core`,
   `@janela/protocol`, `@janela/client`, `@janela/design`, `@janela/terminal-ui`
   and `@janela/ui` (`scripts/layers.ts`, layer 10, client side). Neither
   `@janela/db`, `@janela/git` nor `@janela/pty` is linked. A failure that used
   to break launch — a migration that will not apply — now surfaces as a
   connection that does not come up.
2. **`start()` runs after first paint, in an effect, and is never awaited.** The
   window paints before the daemon answers. Awaiting the socket on the launch
   path hands the daemon a veto over the launch budget, which is the coupling
   the two-process split exists to remove.
3. **The IPC hop**: WebView ↔ Rust shell ↔ Unix socket. Tauri commands carry
   client → daemon frames; Tauri events carry daemon → client frames. **Raw
   bytes in both directions — never base64, never JSON-wrapped.** Base64 through
   the bridge inflates every repaint by a third and adds two passes per frame,
   which is the mistake ADR 0016 refused on the socket and is no less a mistake
   here (ADR 0023 § added budgets).
4. **Back-pressure lives on the daemon → WebView direction, with two policies.**
   A coalesced repaint may drop its oldest entry, because a newer frame
   supersedes it; control frames and terminal input may not drop, ever.
   `BoundedQueue` in `@janela/support` carries that distinction. Getting it
   wrong shows up as a terminal that is subtly corrupt after a stall.
5. **The shell relays frames and never reads them.** Nothing about projects,
   sessions, terminals or a message's meaning belongs in Rust. If the Rust side
   ever needs to know what a `StateUpdate` is, the boundary has moved and that
   is an ADR rather than a commit.
6. **The Tauri command and event names are not chosen anywhere in the tree.**
   Naming them is issue #30's first decision; this document does not invent
   them, and neither should an implementation before the issue records the
   choice.
7. **The keystroke path** is WebView → Tauri IPC → Rust → socket → daemon → PTY,
   and the echo returns PTY → emulator → socket → Rust → WebView → renderer.
   Each hop is tens of microseconds, two orders of magnitude under a frame, so
   the `< 16 ms` input-to-echo budget is unchanged. **If it regresses, the fix
   is the IPC path, not moving the terminal back into the app.**
8. **Reconnection is the shell's business, not the frontend's.** The Rust side
   owns the socket and its lifecycle; `MessageTransport.incoming()` finishes
   when the shell reports the connection ended, and `@janela/client` asks for a
   new transport (§ 4.1). Two retry loops in two languages is one too many.
9. **The shell's responsibilities are a closed list**, from
   `apps/desktop/src-tauri/src/main.rs` and ADR 0024: the window and its native
   chrome; the native menu bar and its accelerators, built from `@janela/ui`'s
   `COMMANDS` table so the menu and the in-app command surface cannot drift
   apart; native notifications; native file dialogs; the daemon sidecar's
   lifecycle and launch-agent registration; the Unix-socket bridge. Keeping the
   list closed is the point — logic in a shell is logic that cannot be tested
   without the shell.
10. **File dialogs are a rule, not a convenience: the app selects, the daemon is
    handed paths.** TCC attributes access to the process that asked, so a
    directory the user picked in the app carries the user's intent and the
    grant. The daemon never discovers directories, never scans the home
    directory, and never touches a path no client gave it (ADR 0017 § TCC
    attribution).
11. **Registration happens from the shell**, and reports its outcome honestly.
    `requiresApproval` is a supported state, not an error: the app explains it
    plainly and links to the right settings pane. **Degraded mode** is the open
    constraint — ADR 0017 promises in-app terminals until approval, but the
    client cannot spawn a process and the layering gate makes that structural,
    not an omission (`@janela/pty` is not linked and could not be). The
    constraint is recorded here; the mechanism belongs to issue #39, and this
    document does not prescribe one. ADR 0017 says the app runs a degraded
    in-app mode; the code says the client has no way to run a process; the code
    wins, and the reconciliation is #39's.
12. **A running daemon is never terminated for our convenience.** launchd owns
    the lifecycle: socket activation starts the sidecar on first connection, and
    it outlives clients (ADR 0017). "Stop Background Service" is a deliberate
    user action, not something the app does on quit.
13. **The sidecar is one file.** `bun build --compile` embeds the runtime, the
    generated database client, the emulator and the PTY library, which keeps the
    bundle at two signed executables — `Contents/MacOS/Janela` and
    `Contents/Resources/janelad`, both hardened, Developer ID signed and
    notarized as one bundle (ADR 0008 as amended). The LaunchAgent plist ships
    inside the bundle at `Contents/Library/LaunchAgents/`.
14. **Notification delivery is the app's, policy is the client's.** The app
    implements `AttentionDelivering` (§ 4.1) over
    `@tauri-apps/plugin-notification`, owns authorization — requested lazily on
    the first delivery that would otherwise occur, never at launch — and owns
    click routing: activate, select the session, focus the terminal, withdraw.
    The body is never logged, never included in an error report and never
    persisted. ADR 0011 names the pre-migration delivery API; the plugin
    replaces it and the policy/delivery split it decided is unchanged.
15. **One log format for both processes.** `main.tsx` installs `setLogSink` over
    `@tauri-apps/plugin-log`, so a client record and a daemon record carry the
    same shape and the same categories and can be read side by side. Until a
    sink is installed, records are dropped rather than printed.
16. **`@tauri-apps/*` is gated to this package** by `scripts/layers.ts` — "Tauri
    is the shell, not the architecture". `@janela/client` stays
    transport-agnostic, so a browser client replaces `transport.ts` with a
    WebSocket implementation and changes nothing above it.

**Seams**:

- `apps/desktop/src/environment.ts` — build the transport and ensure the daemon
  is registered as a launch agent if it is not already.
- `apps/desktop/src/transport.ts` — implement over Tauri's IPC: bytes not
  strings, bounded back-pressure with the two policies, reconnection left to the
  shell.
- `apps/desktop/src/main.tsx` — mount `MainWindow` with the live environment,
  call `start()` in an effect, install the log sink.
- `apps/desktop/src-tauri/src/main.rs` — the window and native menu; the socket
  bridge; sidecar lifecycle and launch-agent registration.

**Build deliverables** (required by issue #41; checked against the tree — **none
of the five exists today**, and `apps/desktop` currently holds only
`package.json`, `tsconfig.json`, `src/environment.ts`, `src/main.tsx`,
`src/transport.ts` and `src-tauri/src/main.rs`):

- `apps/desktop/src-tauri/Cargo.toml` — missing.
- `apps/desktop/src-tauri/tauri.conf.json` — missing; carries the bundle, the
  sidecar and the signing configuration.
- `apps/desktop/src-tauri/capabilities/` — missing; the allowlist for
  `plugin-notification` and `plugin-log`, which are declared as dependencies of
  the app and reachable from nowhere else.
- `apps/desktop/index.html` — missing; must agree with `ROOT_ELEMENT_ID`.
- `apps/desktop/vite.config.ts` — missing, while `apps/desktop/package.json`'s
  `build` script is `vite build` and its `dev` script is `tauri dev`.

One further gap in the same set: `apps/desktop/package.json` exports
`./src/index.ts` and that file does not exist. Either the export map or the file
is wrong; issue #30 lands the composition root and settles it.

**Test strategy**:

- **Bytes across the bridge**: push invalid UTF-8 through it and compare the
  bytes on the far side. This is the assertion ADR 0024 asks for by name,
  because the failure is silent otherwise — a string round-trip corrupts exactly
  the escape sequences that matter and nothing throws.
- Launch: the sidebar shows mirrored state, and it paints before the connection
  is up.
- Create a session: it appears in the sidebar and in the daemon's database.
- `bun run daemon:restart`: the client reconnects, re-subscribes, and receives a
  full snapshot and a fresh full repaint; the sessions the restarted daemon
  restored from its database appear as idle.
- Back-pressure: a stalled WebView drops coalesced repaints and loses no control
  frame and no input byte.
- Notification delivery is manual, as are the approval and denial paths — the
  policy that decides them is unit-tested in `@janela/client` (§ 4.1) against a
  recording deliverer, which is what keeps the app's part to an adapter.
- The Rust shell has no unit tests worth writing while it holds no logic. A Rust
  test that needs protocol meaning is the signal that decision 5 has been
  broken.

---

## V. Optional Features (Can Be Built in Any Order After Core)

### 5.1 .worktreeinclude — Copy Ignored Files Into Worktrees

**Status**: Independent. Requires `@janela/git` (§ 1.2) for the copy itself and
`@janela/session` (§ 3.2) for the ordering. The interface exists; the body is a
seam owned by issue #18, and where the size cap lives is issue #26's call.

**Requirements**: ADR 0013, ADR 0007, ADR 0014 (ordering),
`docs/domain-model.md` § AutomationCommand.

**Specification**: the interface is `WorktreeIncluding` in § 1.2
(`packages/git/src/worktree-include.ts`) — `resolve(repository)` and
`copy({repository, worktree, paths})` returning a `CopyReport`. The place it is
called from is the creation ordering in § 3.2: `git worktree add`, then this
copy, then the `worktreeCreated` automation command, then `sessionStart`. That
ordering is fixed, not incidental — automation scripts depend on their `.env`
already being on disk.

**Implementation decisions**:

1. **git does the matching**: `git -C <source> ls-files -o -i
   --exclude-from=.worktreeinclude -z --directory`. `-o -i` lists exactly the
   untracked-and-ignored set, because anything tracked is already in the new
   worktree; `--directory` collapses a wholly-untracked directory so
   `node_modules/` arrives as one path rather than 40,000; `-z` because paths
   may contain newlines (ADR 0007). We never write a gitignore matcher — ours
   would disagree with git's the first time someone used a negation. Verified
   against git 2.49 in ADR 0013.

2. **`clonefile(2)` moves the bytes**: on APFS a clone is metadata-only, which
   is what makes a 500 MB `node_modules` cost milliseconds. A cross-volume or
   non-APFS filesystem falls back to a byte-for-byte copy; the fallback is
   allowed to be slow and is not allowed to be silent, so it is reported as
   `CopyReport.usedFallbackCopy` and logged. ADR 0013 names the old client's
   file-manager API as the fallback; that framework is gone — the fallback is a
   plain filesystem copy inside the daemon; the code wins.

3. **The bounds are the ADR's, all non-negotiable**: never follow a symlink out
   of the repository (a symlink is copied as a symlink, never dereferenced);
   measure total size first and cap it at **2 GB by default**, past which the
   user is asked **once**, with the actual number and the offending path, and
   the session is created either way — an oversized include never blocks
   getting a terminal; never copy `.git`, regardless of patterns; per-path
   failures are logged by path shape, skipped, non-fatal.

4. **The cap is stated by ADR 0013 and not carried by the interface**:
   `WorktreeIncluding.copy` takes no budget and `CopyReport` has no
   "skipped because too large" field, so neither the measurement nor the
   one-time prompt has a home in the current contract. Where they land — a
   `copy` option, a separate measuring call, or a `@janela/session` concern
   above it — is issue #26's decision. Do not infer one from the interface as
   it stands.

5. **What was copied is recorded** on `WorktreeBinding.includedPaths` (§ 2.1)
   from `CopyReport.copied`, so the removal dialog in § 3.2 can name the 400 MB
   `node_modules` and the `.env` that exists nowhere else instead of asking
   "are you sure?".

6. **A missing `.worktreeinclude` is the common case**, not an error:
   `resolve()` returns an empty list and the copy step is skipped.

**Test strategy** (additional to § 1.2's `.worktreeinclude` tests):

- Real repository via `gitFixture()`; `.worktreeinclude` listing
  `node_modules/` and `.env`, both populated; create the worktree, run the
  copy, then assert on the report rather than on the filesystem alone:
  `CopyReport.copied` names both paths, `CopyReport.totalBytes` equals the
  measured size of what landed, and `usedFallbackCopy === false` on APFS.
- Prove the clone actually happened rather than trusting the flag: `stat` a
  copied file and assert an inode link count greater than 1, which is what
  distinguishes a clone from a byte copy.
- Assert what did **not** land: an ignored-but-unlisted directory, an
  untracked-but-unlisted file, and `.git`.

---

### 5.2 Automation — Project Commands

**Status**: Independent. Requires `@janela/session` (§ 3.2). Seam: issue #27
owns `AutomationRunning`; the creation and removal flows that call it are
issues #25 and #26.

**Requirements**: ADR 0014 (amended by ADR 0015), ADR 0013 (ordering),
`docs/domain-model.md` § AutomationCommand.

**Specification**: the interface is `AutomationRunning` in § 3.2
(`packages/session/src/automation-runner.ts`) — `run({event, project,
session})` returning an `AutomationReport` with one entry per command, in
order, each carrying an optional `exitCode` and a `timedOut` flag. The three
events are `AUTOMATION_EVENTS` in § 2.1: `worktreeCreated`, `sessionStart`,
`sessionTeardown`. `AutomationCommand.timeoutSeconds` defaults to 30 in the
schema (§ 1.3).

**Implementation decisions**:

1. **`command` is an argv array, never a shell string** — the same rule as
   `LaunchProfile`, for the same reason: no quoting bug class, no `sh -c`. A
   user who wants a shell writes `["zsh", "-lc", "…"]` and has chosen that
   explicitly.

2. **Automation is visible** (non-negotiable #12): each command runs in a real
   terminal with `role: automation(event)`, in the session's directory, with
   the session's environment, that the user can watch, scroll back through and
   Ctrl-C. Nothing run on the user's behalf happens in a hidden process — which
   is why this type creates terminals instead of capturing output.

3. **Commands for one event run in order and do not gate each other.** No
   scheduling, no retries, no dependency graph, no conditional execution. If
   step two needs step one, it is one command.

4. **Failure is visible and non-fatal**: a non-zero exit leaves the terminal
   open showing the output, with the tab marked failed. The session exists and
   is usable. The only thing never done is swallowing it silently.

5. **`sessionStart` runs once per session**, not per daemon start and not per
   client attach. Reconnecting, or connecting from a second client, does not
   re-run `pnpm dev` — it is very likely still running. The daemon records that
   it fired; the user restarts the terminal to run it again.

6. **`sessionTeardown` is the only blocking event**, bounded by each command's
   `timeoutSeconds`, and it **survives the asker leaving**: a client may request
   removal and disconnect a second later, and the daemon still runs teardown to
   completion, reporting the outcome to whoever is attached when it finishes —
   or to nobody, which is a supported outcome. Deletion never hangs on a
   script.

7. **`run()` returns once the terminals have been created**, not once the
   commands have finished — except for `sessionTeardown`. That is what keeps
   session creation off the network and off a user's `pnpm install`.

8. **`JANELA_*` environment variables** identify the session, its directory, its
   branch and the event, so one script can serve several projects. They come
   from `janelaVariables` in § 3.2, not from this type.

**Test strategy**:

- `temporaryDatabase()`, a real PTY and a real emulator. Create a project with
  a `sessionStart` command `["echo", "started"]`, create a session in it, then
  assert: a terminal exists whose role is automation for `sessionStart`
  (`isAutomation(role)`); its state goes `running` → `exited(0)`; and
  `snapshotText({includeScrollback: false})` contains `started`.
- A command exiting non-zero: the terminal stays live-but-exited, the report
  records the code, and the session is still usable — failure is non-fatal.
- Two commands for one event: `AutomationReport.commands` is in declaration
  order.
- `sessionTeardown` with a command that sleeps past its `timeoutSeconds`:
  `timedOut` is true and `run()` still resolves — with a fake clock, so the
  test does not sleep.
- Removal requested and the requester disconnected immediately: teardown still
  runs to completion.

---

### 5.3 @janela/forge — Pull Request State and Checks

**Status**: Independent, and genuinely optional — a user without `gh` sees an
app with no forge column and no nagging. Requires `@janela/git` (§ 1.2) for the
remote and branch, and `@janela/session` (§ 3.2) for the session it hangs off.
Planned, not implemented: the whole package is one `TODO:` under issue #33. It
is a **new** seam, not one the migration carried across — the package was
designed and empty, so there was nothing to carry.

**Requirements**: ADR 0012, ADR 0007, `docs/product.md` § Non-goals.

#### ForgeServing

```ts
export interface ForgeState {
  readonly host: Forge;
  readonly pullRequest?: PullRequestSummary;
  readonly checks?: CheckRollup;
  readonly refreshedAt: Instant;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
  readonly url: string;
}

export type CheckRollup = "passing" | "failing" | "running" | "none";

export interface ForgeServing {
  isAvailable(host: Forge): Promise<boolean>;

  state(request: {
    readonly project: Project;
    readonly session: Session;
  }): Promise<ForgeState | undefined>;

  pullRequestBranch(request: {
    readonly project: Project;
    readonly number: number;
  }): Promise<string | undefined>;
}
```

**Implementation decisions**:

1. **Shell out to the user's own `gh` and `glab`**, already authenticated —
   including to enterprise hosts and through SSO — through `ProcessRunning`
   from `@janela/support/process`. Janela never asks for a token, never stores
   one, and never implements a forge API client. `Forge` is derived from the
   remote URL and the binary's presence on `PATH`, cached on the project's
   `GitDescriptor` and re-checked lazily, never on the launch path.
   `isAvailable(host)` is called before anything is offered: a `false` hides a
   feature, it never shows a broken one.

2. **Every read is JSON with an explicit field list**: `gh pr view <branch>
   --json number,title,state,isDraft,url,statusCheckRollup` and `glab mr view
   <branch> --output json`. Human output is never scraped. The explicit list is
   what turns a field rename into a failure we can detect and degrade on rather
   than a silently missing value.

3. **Absence, never an error banner** (non-negotiable #10): a missing binary, a
   logged-out CLI, a rate limit, an unreachable enterprise host and a network
   failure all resolve to `undefined`. Every field of `ForgeState` past `host`
   and `refreshedAt` is optional for the same reason. No dialog, no retry loop,
   no error state in the sidebar — absence renders as absence.

4. **Nothing waits on it.** A refresh is network-bound (~200–400 ms per call)
   and is never awaited on a path a client initiated or is waiting for; it
   publishes through `StateObserving` when it arrives. Everything here is a
   cache with a timestamp, never a source of truth: refreshed when a session
   becomes visible and at most once a minute per branch, because the rate limit
   is the user's to spend.

5. **Log the subcommand and the failure class, never the JSON**
   (non-negotiable #11): the payload carries branch names, private repository
   names and PR titles, and the daemon writes to the same system log the app
   does.

6. **One write action, and it does not check anything out**:
   `pullRequestBranch()` resolves a PR's head branch and hands back the name so
   § 3.2's `fromPullRequest` can create a worktree from it. Never `gh pr
   checkout`, which mutates the user's own checkout — the whole point is that we
   do not touch their working directory. Everything beyond the two questions
   ("is there a PR?", "is CI green?") opens a browser.

7. **`@janela/forge` and `@janela/git` are peers and never import each other.**
   Shared subprocess plumbing lives in `@janela/support/process`; anything they
   both need is a support-layer concern, enforced by `scripts/layers.ts`.

**Test strategy**:

- `fakeProcessRunner()` from `@janela/test-support`: `stub(match, outcome)`
  queues canned stdout, and `invocations` is asserted so the test pins the argv
  — the explicit `--json` field list included.
- The success case is the easy one: canned `gh pr view` JSON parses to the
  expected `PullRequestSummary` and `CheckRollup`. The failure cases matter
  more, and each asserts `undefined` plus a log record that names the failure
  class and contains none of the payload:
  - binary missing on `PATH` — `isAvailable(host)` is false and `state()` is
    never invoked;
  - `gh` exits non-zero with "not logged in" on stderr;
  - malformed or truncated output, and output missing a requested field, which
    is the field-rename detector from decision 2;
  - a call that never returns, bounded and reported as a timeout.
- A recording `StateObserving` proves the refresh publishes rather than being
  awaited: session creation resolves before any forge invocation completes.

---

### 5.4 Attention Signals — BEL, OSC 9/777, OSC 133

**Status**: Integrated. Detection is in `@janela/terminal` (§ 3.1), the wire
shape is in `@janela/protocol` (§ 3.3) and the decision to interrupt is in
`@janela/client` (§ 4.1). No section of its own to implement — issues #21
(parsing), #22 (wire) and #28 (policy).

**Requirements**: ADR 0011, ADR 0006, ADR 0015.

**Specification**: the emulator reports through `TerminalEventSink.onAttention`
(a `TerminalNotification` with optional `title` and `body`) and
`TerminalEventSink.onPromptMark` (`PromptMark`: `promptStart`, `commandStart`,
`commandFinished` with an optional `exitCode`), both in § 3.1. The daemon
normalises those into `AttentionSignal` with an `AttentionKind` of `bell`,
`notification {title?, body}` or `promptFinished {exitCode?, durationSeconds}`
(§ 3.3), and `AttentionPolicy.shouldDeliver` in § 4.1 decides what it means.

**Implementation decisions**:

1. **The parser reports; the policy decides.** The emulator sees a BEL because
   it owns the grid, and it knows nothing about which terminal a human is
   looking at. `onAttention` therefore carries a fact, never a verdict, and
   contains no notion of frontmost, selected or focused — those live in
   `AttentionContext` in the client, which is the process with a window.
   Shipping focus state to the daemon so it could decide would be a chatty
   protocol serving no one.

2. **The list is mechanical**: every entry corresponds to a real escape
   sequence or a real process event. There is no `agentIsThinking`, because no
   terminal sequence means that (ADR 0006).

3. **The signal arrives per terminal, not per session.** A session's badge is
   derived from its panes (§ 4.4). In-app state — the pane indicator and the
   sidebar badge — updates regardless of what `shouldDeliver` returns; the
   sidebar is the primary channel and needs no permission.

4. **`AttentionSignal.id` is set by the daemon** so two connected clients
   suppress a signal they have both already delivered, and the coalescing
   window is `COALESCING_WINDOW_SECONDS = 5` per terminal (§ 4.1).

**Test strategy** (additional to § 3.1's and § 4.1's):

- Parsing, against a real `@xterm/headless` emulator, asserting on a recording
  `TerminalEventSink`:
  - feed BEL (`\x07`) → `onAttention` fires, normalised to
    `AttentionKind.kind === "bell"`;
  - feed `\x1b]9;Notification body\x07` → `onAttention` with `body ===
    "Notification body"` and no `title`;
  - feed `\x1b]777;notify;Title;Body\x07` → `onAttention` with `title ===
    "Title"` and `body === "Body"`;
  - feed `\x1b]133;A\x07`, `\x1b]133;C\x07`, `\x1b]133;D;1\x07` → `onPromptMark`
    with `promptStart`, `commandStart`, then `commandFinished` with `exitCode
    === 1`;
  - a truncated or unterminated OSC string never fires an event and never
    corrupts the grid.
- Policy, with a fake clock and a recording `AttentionDelivering`:
  - `promptFinished {exitCode: 0, durationSeconds: 2}` → no delivery;
  - `promptFinished {exitCode: 1, durationSeconds: 2}` → no delivery, because a
    short command failing is normal work;
  - `promptFinished {exitCode: 1, durationSeconds: 15}` → delivered, the one
    case past `LONG_RUNNING_THRESHOLD_SECONDS = 10`;
  - `bell` → never delivered, badge only; `notification` → always delivered;
  - four bells inside `COALESCING_WINDOW_SECONDS` → one signal's worth of
    in-app state, one delivery at most, never four.

---

## VI. Repaint Encoder (Deliberately Last)

### 6.1 Damage Tracking and Minimal Escape Sequence Encoding

**Status**: Seam, and the most complex piece in the system. A naive full
repaint every frame is a correct placeholder, so everything above this section
is functional before any of it is written. Issue #32.

**Requirements**: ADR 0018, ADR 0016.

**Goal**: turn "these cells changed" into the smallest correct escape sequence
that reproduces the changed grid on a client which has already seen everything
up to a given revision.

#### TerminalEmulating

The three damage-tracking members, from
`packages/terminal/src/terminal-emulating.ts`; the full interface is in § 3.1.

```ts
readonly revision: number;

repaintSince(revision: number): Uint8Array;

fullRepaint(): Uint8Array;
```

**Implementation decisions**:

1. **The damage handle is a number**: `revision` is monotonic and bumped
   whenever the grid changes. Reading it must not be a synchronisation point —
   it is polled once per frame per attached client. A client that last saw
   revision N asks `repaintSince(N)`; an empty view is the common case and must
   be cheap.

2. **Encoding strategy**: absolute cursor positioning (`\x1b[<row>;<col>H`) or
   relative moves (`\x1b[A/B/C/D`), SGR runs (`\x1b[<attrs>m`), text runs as
   UTF-8 bytes, and `\x1b[K` / `\x1b[J` where clearing is shorter than
   rewriting. Diff the previous grid against the current one and emit the
   smallest sequence set. Prior art to read rather than reinvent: tmux's
   `screen-write` / `tty` pair, which does exactly this diffing against a
   remembered screen, and xterm.js's own `@xterm/addon-serialize`, which
   already produces a whole-grid form of the same output.

3. **The encoder emits escape sequences, not a grid format**. That is what
   makes the daemon's `@xterm/headless` and the client's `@xterm/xterm` survive
   being different libraries (ADR 0018 § Consequences): the two sides need only
   agree on VT semantics, never on an internal representation. It is also why a
   client that already knows how to be a terminal needs to learn nothing new.

4. **The dumb path stays available forever**: `fullRepaint()` every frame is
   always a valid fallback for `repaintSince`, so the hard optimisation is only
   ever able to be slow, never wrong. `fullRepaint()` itself is
   `@xterm/addon-serialize`, round-trip verified in the migration spike — 143
   bytes for content spanning five rows, 1802 bytes for a 100×30
   alternate-screen TUI, cursor position and buffer type preserved.

5. **The assertion that matters most is a shape, not a number**: socket traffic
   must track *frame rate*, not throughput — at most 2 MB/s on the boundary
   while the PTY sustains 100 MB/s (`docs/performance.md` § Terminal
   throughput). 100 MB/s of `yes` output is at most 60 repaints per second of an
   80×24 grid, and repainting every cell of one every frame stays well under
   the bound. If a profile shows socket bytes rising with throughput, damage
   coalescing is broken.

6. **Deliberately last.** Built when it is the remaining cost, not before,
   because the placeholder makes every section above it shippable and this one
   is the only place where being clever can produce a wrong screen.

**Test strategy**:

- The two-emulator round-trip, which is the test everything else assumes: feed
  bytes to emulator A, encode the damage, feed the encoded bytes to emulator B,
  assert the grids match cell by cell.
- Run that round-trip over recorded output from real full-screen programs —
  `vim`, `htop`, an agent TUI — not only over synthesised sequences.
- Alternate-screen switches in both directions.
- Wide characters split by a resize.
- Scroll regions.
- A resize between damage and encode.
- Detach and reattach after a full-screen redraw: the client receives one
  repaint bounded by grid size, not a replay of the history.
- A flood: assert the encoded bytes per second track the frame rate, and that
  memory plateaus rather than climbing.

---

## VII. Testing Strategy

### General Principles

1. **`bun test`** with `describe` / `test` / `expect`, colocated as `*.test.ts`
   beside the code under test.
2. **Files run in parallel**, so never write to a fixed path, never mutate
   process-global state and never assume ordering. Anything touching the
   filesystem uses `temporaryDirectory()` or `gitFixture()` from
   `@janela/test-support`, both unique per test. A test that writes to a fixed
   path fails under parallelism *intermittently*, which is worse than failing.
3. **Real git, real PTYs, real database, real socket.** A mock of any of them
   proves our assumptions rather than the behaviour. `git worktree add` either
   works against a real repository or it does not. A pseudo-terminal is cheap,
   and controlling terminals, job control, `SIGWINCH` and back-pressure are
   exactly what a fake papers over. `temporaryDatabase()` applies the real
   migrations, because a fake repository tests the fake. And every interesting
   socket bug is a real-socket bug: a partial read, a frame split across two
   `recv` calls, a peer that vanishes mid-frame, a length prefix that lies.
4. **Exactly five collaborators are fakes**, and the reason each one is a fake
   is that the logic under test is the *decision*, not the subprocess:
   automation (the orchestration order, not the command), attention delivery
   (`AttentionDelivering`, so every rule in the policy becomes an assertion),
   forge (`ForgeServing`, where the failure cases matter more than the success
   one), the clock (coalescing windows, teardown timeouts and the idle-exit
   grace period are time-dependent, and a test that sleeps is a test that
   flakes), and `MessageTransport` — **client-side only**. The daemon side
   still binds a real socket, so the pairing is covered somewhere; faking both
   ends would test nothing.
5. **Name the behaviour, not the method**, one reason to fail per test, assert
   on outcomes rather than on calls, and a test written for a bug reproduces
   that bug before the fix lands.

---

### Test Fixtures

```ts
export interface TemporaryDirectory extends AsyncDisposable {
  readonly path: string;
  join(...components: string[]): string;
}

export function temporaryDirectory(label?: string): Promise<TemporaryDirectory>;

export interface GitFixture extends AsyncDisposable {
  readonly path: string;
  git(...args: string[]): Promise<string>;
  commit(file: string, contents: string, message?: string): Promise<void>;
}

export function gitFixture(label?: string): Promise<GitFixture>;

export interface RecordingLogSink {
  readonly records: readonly { readonly message: string; readonly fields?: unknown }[];
  install(): void;
  reset(): void;
}

export function recordingLogSink(): RecordingLogSink;

export interface FakeProcessRunner {
  readonly invocations: readonly {
    readonly executable: string;
    readonly arguments: readonly string[];
  }[];
  stub(match: string, outcome: { stdout?: string; stderr?: string; exitCode?: number }): void;
}

export function fakeProcessRunner(): FakeProcessRunner;
```

Notes on the fixtures, each of which is a constraint rather than a convenience:

- `gitFixture()` is a throwaway repository with one commit on `main`, and it is
  **hermetic on purpose**: `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0` and
  `commit.gpgsign=false`, so the suite passes on a machine with signing
  configured globally. A test that depends on the developer's git config is a
  test that fails in CI for reasons nobody can reproduce.
- `FakeProcessRunner` is typed **structurally** against `ProcessRunning` rather
  than importing `@janela/support/process`: that subpath is daemon-only and
  `@janela/test-support` is linked by both sides. Its body, like
  `ProcessRunning`'s, is owned by issue #18.
- `RecordingLogSink` exists so a test can assert that we log *shapes* and not
  content — the case that matters is attention delivery, whose body must never
  reach a log.
- **There is no socket-path helper.** `sun_path` is 104 bytes (ADR 0016,
  `MAXIMUM_SOCKET_PATH_LENGTH` in `packages/daemon/src/endpoint.ts`), and a
  temporary directory plus a test name gets close, but nothing in
  `@janela/test-support` shortens it today. Until a helper lands, a daemon test
  must pass a short `label` to `temporaryDirectory()`, build the socket path
  with `join()`, and assert its byte length against
  `MAXIMUM_SOCKET_PATH_LENGTH` before binding — a path that is silently
  truncated does not error, it addresses a *different* socket.

---

### Cascade Tests

Every cascade encodes a product rule, which is the reason they are tested at
this level at all: reversing the rule must break a named test, so that changing
it is a conscious act. Each of these opens a `temporaryDatabase()` — a real
SQLite file with the real migrations applied — writes through the repositories
in `packages/db/src/repositories.ts`, and reads back through them:

- **Deleting a project removes its sessions and their terminals.** Create a
  project, a session in it with two terminals in its layout; call
  `projects.remove(id)`; assert `sessions.inProject(id)` is empty and
  `sessions.find` no longer returns the session, so neither terminal
  descriptor is reachable. Two cascade hops in one assertion, because the
  second hop is the one a hand-written delete forgets.
- **Deleting a launch profile leaves the terminal descriptors and nulls their
  profile reference.** Create a profile, a terminal that names it, call
  `launchProfiles.remove(id)`; assert the session still loads, its terminal is
  still there, and `TerminalDescriptor.profileID` is now absent — a terminal
  with no profile falls back to the login shell. The schema half of the rule is
  `profileId String?` with `onDelete: SetNull`. A profile is a convenience,
  never the identity of a terminal.
- **A standalone session survives every project deletion.** Create a standalone
  session — no `projectID`, per `backingViolations` in
  `packages/core/src/session.ts` — plus a project with its own session; remove
  the project; assert `sessions.standalone()` still returns it. It belongs to
  no project, so nothing done to a project can take it away.
- **Deleting a launch profile nulls a project's default.** Point a project's
  `defaultProfileID` at a profile (`defaultProfileId` with `onDelete: SetNull`
  in the schema), remove the profile, assert `projects.find` returns the
  project with no default rather than failing to load. A dangling default must
  degrade to "no default", never to an unreadable project.
- **Forward from the previous version.** Open a database at the schema version
  before the change, migrate, and assert the data survived. This is the test
  that stops us destroying a user's session list, and every migration gets one.

---

### Module Test Coverage

| Package | What to Test | How |
| --- | --- | --- |
| `@janela/pty` | Spawn, drain, resize, signals, back-pressure | Real children |
| `@janela/git` | Worktree list/add/remove, `-z`, safety | `gitFixture()` |
| `@janela/db` | Round-trip, cascades, migrations | `temporaryDatabase()` |
| `@janela/core` | Layout algebra, invariants, round-trip | Pure unit tests |
| `@janela/protocol` | Framing, handshake, encode/decode | Pure unit tests |
| `@janela/terminal` | Feed, resize, damage, snapshot | Real `@xterm/headless` |
| `@janela/session` | Order, automation | `temporaryDatabase()`, fakes |
| `@janela/daemon` | Handshake, auth | Real socket, `temporaryDirectory()` |
| `@janela/client` | Reconnect, mirror, attention | In-memory transport |
| `@janela/forge` | Canned JSON, missing, logged out | `fakeProcessRunner()` |
| `@janela/terminal-ui` | Feed, viewport, input | Manual against a real daemon |
| `@janela/ui` | Presentation logic, commands | Manual against a real daemon |

The table is a summary; three mechanisms it has no room for are not optional.
The daemon's real socket also carries its subscription and idle-exit tests —
`@janela/daemon` is the best test surface in the system because its whole
interface is a socket: start a daemon on a temporary path, connect a test
client, drive it with real messages, and the entire session lifecycle is
testable headlessly, with no window server. `@janela/client`'s attention rules
run against a **recording `AttentionDelivering`** and a fake clock beside the
in-memory transport, which is the whole reason policy and delivery were
separated. And `@janela/session` names two fakes: a fake `WorktreeServing`,
because the point of those tests is the orchestration order rather than git,
and a fake clock for the teardown timeout.

The two UI rows are deliberately thin: presentation logic only, no snapshot
tests, and any logic worth testing belongs in a store where it can be tested
directly.

---

## VIII. Out of Scope for V1

Per [`product.md`](product.md) § Non-goals and individual ADR decisions:

- **Remote client** (phone, browser): the protocol is transport-agnostic and
  ready; the listener is deferred (ADR 0016, ADR 0023).
- **Cloud sessions or sync**: the daemon is a local process. No accounts, no
  server we operate.
- **A Linux or Windows build**: Tauri would mostly permit it; the testing and
  support commitment is the cost, and the answer is no until its own ADR says
  otherwise (ADR 0023).
- **A second FFI surface**: `bun:ffi` is gated to `@janela/pty`, and the one
  native library we ship is the PTY's. Anything else that wants native code
  argues for it in an ADR first (ADR 0021, ADR 0022).
- **Per-session settings**: settings are global or per-project.
- **Saved or named layouts**: the layout is wherever you left it, stored on the
  session.
- **Nested projects, folders or tags**: two levels, flat within each.
- **Agent-specific integrations**: terminal signals only; never infer an agent's
  semantics (ADR 0006).
- **Forge write actions** (merge, approve, comment): open the browser (ADR
  0012).
- **Sessions surviving a reboot**: they survive the app quitting, not the
  machine restarting (ADR 0017).
- **A `janela notify` CLI**: documented as the v2 option in ADR 0006.
- **Per-pattern symlinks in `.worktreeinclude`**: deferred, and additive when it
  lands (ADR 0013).

---

## IX. Performance Budgets

From [`performance.md`](performance.md) and ADR 0023.

| Path | Budget | Why |
| --- | --- | --- |
| Launch (cold, no sessions) | **400 ms** | First impression; a WebView process plus a JS bundle is a real cost |
| Launch (warm, existing sessions) | **200 ms** | Real working state; the window paints before the daemon answers |
| Create session (simple) | < 100 ms | Feels instant |
| Create worktree-backed session | 1–3 s | git plus the `.worktreeinclude` copy; the user expects a wait |
| Terminal input → echo visible | < 16 ms | The perception threshold for something interactive |
| Split drag → reflowed panes | 1 frame, resizes coalesced | Each resize is a `TIOCSWINSZ`, a `SIGWINCH` and a reflow, on two terminals |
| Flood handling | Frame rate bounded | A 100 MB/s `yes` must not allocate unbounded memory |
| Reconnect after a daemon restart | < 2 s | Back-off is acceptable here |
| Terminal bytes crossing Tauri's IPC | Raw payloads: no JSON, no base64 | 33% inflation plus two passes per frame (ADR 0023) |
| Memory per idle session | Flat | A JavaScript heap makes "an unstarted terminal costs a value" less automatic (ADR 0023) |
| Sustained PTY throughput, no stall | ≥ 100 MB/s budget, **133 MB/s measured** | daemon (ADR 0020) |
| Bytes on the socket during a flood | ≤ 2 MB/s | The single most valuable assertion in the flood test |
| Client frame rate during a flood | ≥ 60 fps | client |

Cold and warm launch are revised from 250 ms / 120 ms in ADR 0023 because the
client renders in a WebView; every other budget above is unchanged.

The client's 60 fps and the daemon's drain interval are different numbers on
purpose: the daemon drains and feeds once per frame at 120 Hz —
`COALESCING_WINDOW_MS = 8` — so that a client rendering at 60 fps never waits on
a coalescing window.

**Rules of thumb**:

- PTY read → emulator feed allocates nothing per chunk. `drain()` returns a view
  into a reusable buffer, and `feed()` is called once per frame with the whole
  chunk.
- Damage encode is amortised O(changed cells), never O(grid).
- Database writes are never on the launch path, and nothing user-initiated waits
  on a subprocess.
- Forge state is best effort and never awaited.
- Coalesce at the boundary, not after it: anything sent per byte or per chunk
  over the socket is a bug.
- Bound every buffer, and write the bound down next to it — per-client output
  queues included, not just the read path.
- **Never block the event loop.** This is the rule that replaces the isolation
  rules a compiler used to check for us (ADR 0020).

---

## X. Developer Workflow and Validation

### Daily Loop

Every command is a `bun run` script; the toolchain is Bun workspaces and
Turborepo, with Oxc for lint and format (ADR 0025). Do not invent new
invocations.

```bash
bun run typecheck    # seconds; tsc --build across every package
bun test             # all tests, run in parallel
bun run lint         # oxlint, format check, and the layering gate
bun run check        # lint + typecheck + test; exactly what CI runs
```

Once, and after specific changes:

```bash
bun run bootstrap        # install, generate the database client, build the native library
bun run generate         # after touching packages/db/prisma/schema.prisma
bun run build:native     # after touching packages/pty/native/src/lib.rs
bun run check:layers     # the layering gate alone, after touching a dependency edge
bun run app              # build and run the app; drives cargo, takes minutes
bun run daemon:restart   # stop janelad so the next connection starts your build
bun run daemon:status    # which janelad is resident, and from where
```

Prefer `bun run check` over building the app: it covers everything except the
Tauri shell and finishes in seconds.

Two things that will bite once each:

- **A resident `janelad` from another checkout will serve your app.** That is by
  design — it holds the user's terminals — but during development it means
  testing code you did not build.
- **Prisma's CLI runs on Node, not Bun**, and rejects unsupported versions. The
  pinned version is in `.node-version`. Nothing we ship uses it.

### Before Finishing

Per [`AGENTS.md`](../AGENTS.md) § Before you finish:

- [ ] `bun run check` passes.
- [ ] Every new dependency edge points downward, does not cross the
      daemon/client line except through `@janela/core` or `@janela/protocol`,
      and is declared in **both** `scripts/layers.ts` and the package's
      `package.json`; `bun run check:layers` agrees.
- [ ] No wire-protocol change without a version bump and a stated older-peer
      story.
- [ ] No new user-facing concept without justification against
      [`product.md`](product.md) § Non-goals — the budget is four nouns.
- [ ] No use of the word "workspace"; it is a project or a session.
- [ ] No architectural decision changed without an ADR in `docs/decisions/`.
- [ ] Nothing added that allocates per byte or per frame on the terminal path
      without a budget in [`performance.md`](performance.md).

---

## XI. Current State and Immediate Next Steps

The repository is **scaffolded, not implemented**. Packages export their
interfaces and their `TODO:` seams; most bodies are not written. The work queue
is `grep -rn "TODO:" packages apps`, and each seam carries a doc comment
describing what belongs there and which traps to avoid.

**Immediate priorities**, dependency-ordered:

1. **`@janela/pty`** (§ 1.1): the spawn path, the reader thread and its water
   marks are **done** and cargo-tested (#16); what remains is the daemon-side
   once-per-frame drain and `@janela/support`'s bounded queue (#17).
2. **`@janela/git`** (§ 1.2): `gitRunner` and `worktreeService`, porcelain `-z`
   parsing, `removalSafety`, `.worktreeinclude` (#18).
3. **`@janela/db`** (§ 1.3): the driver adapter over `bun:sqlite` (#40), then
   the repositories, the first migration, and the cascade tests (#19).
4. **`@janela/core` layout algebra** (§ 2.1): `splitPane`, `closeTerminal`,
   `focusNeighbour`, `resizeSplit`, `repairLayout`, the depth bound and the
   fraction clamp (#20).
5. **`@janela/terminal`** (§ 3.1): `TerminalEmulating` over `@xterm/headless`,
   and `LiveTerminal` (#21).
6. **`@janela/session`** (§ 3.2): the project and session services,
   `.worktreeinclude` copying, and the automation runner (#25, #26, #27).
7. **`@janela/protocol` + `@janela/daemon` + `apps/daemon`** (§ 3.3): framing,
   handshake, the socket listener, the frame loop, launchd lifecycle (#22, #23,
   #24, #35, #39).
8. **`@janela/client`** (§ 4.1): connection, reconnection, the mirror stores,
   the attention policy (#28).
9. **`@janela/ui`** and **`apps/desktop`** (§ 4.4, § 4.5): sidebar, tabs,
   splits, the command surface, and the IPC bridge (#29, #30, #36, #37, #38,
   #41).
10. **The repaint encoder** (§ 6.1): damage tracking and minimal escape
    sequences. Last, because a full repaint every frame is a correct placeholder
    (#32).

Cutting across all of it: **#31, the survival proof** — quit the app with an
agent working, reopen, and find it finished with its scrollback intact.

---

## XII. Sign-Off Checklist

Before any component is marked "done":

- [ ] The implementation matches this document, or this document has been
      corrected to match the code.
- [ ] Tests exist that fail before the change and pass after it.
- [ ] `bun run lint` passes: no `any`, no non-null `!`, no `console.log`, `.ts`
      extensions on every import, `import type` for type-only imports, and the
      layering gate green.
- [ ] Doc comments explain *why*; the signature already says what.
- [ ] Nothing crosses the daemon/client line except through `@janela/core` or
      `@janela/protocol`.
- [ ] Any new dependency edge points downward and is declared in both
      `scripts/layers.ts` and the package's `package.json`.
- [ ] Any protocol change is versioned, with a stated behaviour for an older
      peer.
- [ ] Any unbounded allocation is justified in
      [`performance.md`](performance.md) — and there is a documented bound.
- [ ] No terminal traffic, command output, file contents, notification body or
      environment value is logged.

---

## Appendix A: Key Non-Negotiables

From [`AGENTS.md`](../AGENTS.md) § Non-negotiables. Violating one is a change of
direction that needs an ADR, not a style disagreement.

1. Worktree-aware, not worktree-centric: one `Session` type, one creation entry
   point.
2. Two levels, and no more: projects contain sessions, sessions contain
   terminals.
3. Never reimplement the user's tools.
4. The terminal owns the keyboard; `Ctrl-anything` belongs to the running
   program.
5. Laziness is a feature: a configured terminal that has not started costs
   nothing.
6. The daemon is the source of truth; clients render a mirror and have no
   privileged path.
7. Never kill a user's terminals for our own convenience.
8. Nothing blocks across the socket, in either direction.
9. No unbounded buffers; every accumulator has a documented bound.
10. Errors are either shown or logged, never both raw.
11. Never log terminal traffic, command output, file contents, notification
    bodies or environment values.
12. Automation is visible: it runs in a real terminal the user can watch.

---

## Appendix B: Vocabulary

From [`domain-model.md`](domain-model.md) § Vocabulary. UI copy and code use the
same words.

| Say | Not |
| --- | --- |
| project | repository, workspace, group, folder |
| session | workspace, worktree, tab, window |
| terminal | pane, shell, tab, session |
| tab | window, view |
| split | pane, division |
| launch profile | agent, command, tool, preset |
| directory | folder, path, cwd |
| automation command | hook, script, task, job |
| daemon, `janelad` | server, backend, service, agent |
| client | frontend, UI (when you mean the process) |
| attach / detach | connect, open, subscribe (when you mean one terminal) |
| connect / disconnect | attach (when you mean the socket) |

---

## Appendix C: ADR Traceability

| Spec section | ADRs |
| --- | --- |
| § 1.1 `@janela/pty` | 0021; 0020 (rules; reasoning in 0003) |
| § 1.2 `@janela/git` | 0007, 0013 |
| § 1.3 `@janela/db` | 0019 (rules; reasoning in 0005), 0015 |
| § 2.1 `@janela/core` | 0009, 0010 |
| § 3.1 `@janela/terminal` | 0018 (rules; reasoning in 0004), 0015, 0006 |
| § 3.2 `@janela/session` | 0009, 0013, 0014, 0015 |
| § 3.3 protocol and daemon | 0016, 0017, 0020 |
| § 4.1 `@janela/client` | 0011, 0015, 0023; 0020 (rules; reasoning in 0003) |
| § 4.2 `@janela/design` | 0023, 0024 |
| § 4.3 `@janela/terminal-ui` | 0016, 0018 |
| § 4.4 `@janela/ui` | 0009, 0010, 0024 |
| § 4.5 `apps/desktop` | 0024, 0017, 0011, 0008 (as amended) |
| § 5.1 `.worktreeinclude` | 0013 |
| § 5.2 Automation | 0014 |
| § 5.3 `@janela/forge` | 0012 |
| § 5.4 Attention signals | 0006, 0011 |
| § 6.1 Repaint encoder | 0016, 0018 |
| § VII Testing | 0018 (the round-trip test), 0019 (forward migration tests) |
| § IX Budgets | 0023, 0020 |
| § X, § XII Workflow | 0022, 0025 |

The migration of 2026-08-21 reversed six technology choices, carried by five
superseding ADRs plus one edit to [`product.md`](product.md):

| Superseded | Superseded by | What changed |
| --- | --- | --- |
| 0001 | 0024 and 0025 | Project generation, and the monorepo tooling that replaced it |
| 0002 | 0023 | The deployment target |
| 0003 | 0020 | The concurrency model, and with it the daemon's runtime |
| 0004 | 0018 | The terminal engine, behind the same two seams |
| 0005 | 0019 | The SQL layer |
| `product.md` § Non-goals, "Not cross-platform" | 0023 | The cross-platform stance |

ADR 0008 was **amended**, not superseded: unsandboxed, hardened and notarized
survived the change of toolchain with only its bundler different.

The rule this document follows: **the superseding ADR carries the decision, the
superseded one carries the reasoning**, and a citation here names the
superseding number, with the superseded one named only as "reasoning in 00NN". A
note on the index: `docs/decisions/README.md` calls these "six ADRs" in one
sentence and "six technology choices" in another; the second is right, and the
table above is what the index itself lists.

Every requirement above cites an accepted ADR, [`product.md`](product.md),
[`domain-model.md`](domain-model.md), or a source file. Where the code and any
of those disagree, the code is authoritative.
