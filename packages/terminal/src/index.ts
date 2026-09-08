/**
 * `@janela/terminal` — layer 4, daemon side. The authoritative screen.
 *
 * Binds a PTY to a *headless* emulator and owns the grid, damage tracking and
 * repaint encoding. Runs in `janelad`, never in a client; the client's half of
 * this seam is `@janela/terminal-ui`, which draws.
 *
 * One of exactly two packages allowed to name an emulator library, and the rule is
 * enforced rather than reviewed. See docs/decisions/0018-terminal-engine.md.
 */

// `createEmulator` only: `HeadlessEmulator` itself stays inside the package, so
// the emulator library is nameable in exactly one module.
export { createEmulator } from "./headless-emulator.ts";
export * from "./live-terminal.ts";
export * from "./registry.ts";
export * from "./terminal-emulating.ts";
