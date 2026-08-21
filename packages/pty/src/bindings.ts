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
 */

// TODO: `dlopen` the cdylib and expose the symbols below, typed. Import the
// library with `import dylib from "../native/target/release/libjanela_pty.dylib"
// with { type: "file" }` so `bun build --compile` embeds it; the import specifier
// must stay statically analysable or Bun cannot see it at build time.
//
//   jpty_spawn(path, argv, envp, cwd, cols, rows, out_pid) -> handle | -errno
//   jpty_read(handle, buf, len)   -> bytes drained, 0 empty, -1 closed
//   jpty_write(handle, buf, len)  -> bytes written
//   jpty_resize(handle, cols, rows, xpix, ypix)
//   jpty_signal(handle, signo)    -> killpg
//   jpty_exit_code(handle)
//   jpty_close(handle)
//
// Marshalling note that cost time in the spike and will cost it again: the
// `char *const argv[]` and `envp[]` arrays are built as a `BigUint64Array` of
// pointers into per-string `Uint8Array`s, and **every one of those buffers must be
// kept alive** for the duration of the call. Bun's garbage collector does not know
// the native side holds the pointers. Hold them on the handle object.

/** Opaque handle into the native side's terminal table. */
export type PtyHandle = number & { readonly __brand: "PtyHandle" };
