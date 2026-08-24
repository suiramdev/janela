/**
 * The `bun:ffi` binding to `native/`.
 *
 * The only FFI surface in Janela, and the only file permitted to import
 * `bun:ffi` — enforced by `scripts/layers.ts`.
 *
 * ## Locating the library
 *
 * Two cases, and both matter:
 *
 * - **Development.** `bun run` resolves the dylib from
 *   `native/target/release/`, built by `bun run build:native`.
 * - **The shipped sidecar.** `bun build --compile` *embeds* the dylib when it is
 *   imported with `{ type: "file" }`, and `dlopen` resolves it from Bun's virtual
 *   filesystem at runtime. Verified in the migration spike: a single compiled
 *   binary, run from a directory containing nothing else, spawned a real PTY.
 *   This is why `janelad` ships as one file rather than a binary plus a dylib, and
 *   it is what removed a second artifact from ADR 0008's signing story.
 *
 * The hardened runtime still needs `com.apple.security.cs.disable-library-validation`
 * for the `dlopen`, which ADR 0008 already sets so the daemon can spawn and load
 * the user's own unsigned tooling.
 *
 * ## Marshalling
 *
 * `char *const argv[]` and `envp[]` are a `BigUint64Array` of pointers into
 * per-string `Uint8Array`s, and **every one of those buffers must be reachable
 * for the duration of the call**: Bun's garbage collector does not know the
 * native side holds the pointers. `jpty_spawn` returns only once the child has
 * exec'd or died, so `spawnPseudoTerminal` names them in a local and touches that
 * local again after the call rather than pinning them for the terminal's life.
 */

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

// The specifier must stay a literal. A computed one — `libjanela_pty.${suffix}` —
// resolves at runtime and is invisible to `bun build --compile`, which then ships
// a binary with no library in it. Janela is macOS-first (ADR 0023); a second
// platform means a second literal import, which the bundler can also see.
import libraryPath from "../native/target/release/libjanela_pty.dylib" with { type: "file" };

/** Opaque handle into the native side's terminal table. */
export type PtyHandle = number & { readonly __brand: "PtyHandle" };

// `ptr` is re-exported so this stays the only file that names `bun:ffi`.
export { ptr };

/**
 * Added to a child-side errno by `jpty_spawn`, so "couldn't open a terminal" and
 * "couldn't start your program" are two bands rather than a guess about which
 * call an errno came from.
 */
export const JPTY_EXEC_FAILED_BIAS = 2000;

/** What `jpty_exit_code` returns when there is no status to report. */
export const JPTY_NO_EXIT_CODE = -2147483648;

/**
 * The native surface, named rather than inferred so the C ABI is reviewable in
 * one place. `isize` and `usize` cross the boundary as `bigint`.
 */
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

function open(): NativePtyLibrary {
  try {
    return dlopen(libraryPath, {
      jpty_spawn: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u16,
          FFIType.u16,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      jpty_read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      jpty_write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      jpty_resize: {
        args: [FFIType.i32, FFIType.u16, FFIType.u16, FFIType.u16, FFIType.u16],
        returns: FFIType.i32,
      },
      jpty_signal: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      jpty_exit_code: { args: [FFIType.i32], returns: FFIType.i32 },
      jpty_close: { args: [FFIType.i32], returns: FFIType.void },
      jpty_drop_all: { args: [], returns: FFIType.i32 },
    }).symbols;
  } catch (cause) {
    // Not a `PseudoTerminalFailure`: a missing native artifact is a build
    // mistake, not something to show a user. Failing at import is what a
    // contributor with a stale `native/target/` needs to see.
    throw new Error("@janela/pty's native library is missing. Run `bun run build:native`.", {
      cause,
    });
  }
}

/**
 * The native symbols.
 *
 * Opened once at module load rather than memoised on first spawn: a memo is
 * module-level mutable state, and a missing dylib should fail loudly at import
 * with a message naming the build step. Only the daemon imports this package.
 */
export const native: NativePtyLibrary = open();

const encoder = new TextEncoder();

/** A NUL-terminated copy of `value`, which is what `execve` wants. */
export function cString(value: string): Uint8Array {
  const encoded = encoder.encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return bytes;
}

/**
 * A NULL-terminated `char *const[]`, plus the buffers it points into.
 *
 * Both halves have to stay reachable across the FFI call, so they travel together
 * and are never separated.
 */
export interface CStringArray {
  readonly pointers: BigUint64Array;
  readonly buffers: readonly Uint8Array[];
}

export function cStringArray(values: readonly string[]): CStringArray {
  const buffers = values.map(cString);
  const pointers = new BigUint64Array(values.length + 1);
  for (const [index, buffer] of buffers.entries()) {
    pointers[index] = BigInt(ptr(buffer));
  }
  pointers[values.length] = 0n;
  return { pointers, buffers };
}
