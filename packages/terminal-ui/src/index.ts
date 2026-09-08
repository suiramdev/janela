/**
 * `@janela/terminal-ui` — layer 7, client side. The surface that draws.
 *
 * The second and last package allowed to name a terminal library.
 */

export * from "./coalesce.ts";
export * from "./grid-fit.ts";
export * from "./surface-controller.ts";
export * from "./terminal-rendering.ts";
export * from "./terminal-surface.tsx";
export * from "./xterm-rendering.ts";

// `TerminalSurface` wraps the renderer and never does the three tempting things:
//
//   - **Own a PTY.** The library will happily start a process; that is the daemon's
//     job, and a client that spawns one has broken the architecture. The layering
//     gate stops the import; nothing stops a `spawn` option, so none is passed.
//   - **Interpret input.** `onData`/`onBinary` are encoded to bytes and forwarded.
//     No key handler is registered anywhere in this package.
//   - **Re-render on output.** Bytes arrive through `TerminalSurfaceHandle.feed`
//     and go straight into the renderer; the component holds no state at all.
//
// The viewport is reported in *cells*, measured from what xterm drew, and resize
// votes are coalesced to one per frame — docs/performance.md § Interaction budgets
// a reflow at one frame, and an uncoalesced divider drag would send one resize per
// mouse move across two process boundaries.
