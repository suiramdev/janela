/**
 * `@janela/ui` — layer 8, client side. Views and presentation state.
 *
 * Note what is absent from its dependencies: git, PTY, the database, the emulator
 * and the brain are all daemon-side and are not linked here. **The client cannot
 * spawn a process** — the capability is not discouraged, it is not present.
 *
 * Reaches no further than `@janela/client`. A view that wants a fact the mirror does
 * not carry needs a protocol message, not a shortcut.
 */

export * from "./commands.ts";
export * from "./connection-banner.tsx";
export * from "./main-window.tsx";
