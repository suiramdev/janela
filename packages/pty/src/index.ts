/**
 * `@janela/pty` — layer 3, daemon side. The hot path.
 *
 * Pseudo-terminals, child processes, byte pumps, resizing, signal delivery and
 * process reaping. No views, no domain model, no knowledge of sessions — this is
 * the part we must be able to profile in isolation.
 *
 * It is also the only package in the system permitted to import `bun:ffi`, because
 * giving a child a controlling terminal requires `fork` and `login_tty`, which
 * cannot be expressed in JavaScript. The native half is `native/`, a small Rust
 * cdylib; docs/decisions/0021-pty-native-layer.md records why it exists, how it is
 * built, and how it is located at runtime inside a compiled sidecar.
 */

export * from "./byte-stream.ts";
export * from "./pseudo-terminal.ts";
export * from "./size.ts";
