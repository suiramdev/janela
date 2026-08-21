/**
 * `@janela/terminal-ui` — layer 7, client side. The surface that draws.
 *
 * The second and last package allowed to name a terminal library.
 */

export * from "./terminal-rendering.ts";

// TODO: `TerminalSurface`, a React component wrapping the renderer and conforming
// to `TerminalRendering`.
//
// Three things it must not do, and all three are tempting:
//
//   - **Own a PTY.** The library will happily start a process; that is the daemon's
//     job now, and a client that spawns one has broken the architecture. The
//     layering gate stops the import; nothing stops a `spawn` option, so do not
//     pass one.
//   - **Interpret input.** Forward bytes, do not translate them.
//   - **Re-render on output.** The surface is fed imperatively through a ref. A
//     component that puts terminal bytes in state will re-render React 60 times a
//     second and turn the cheapest path in the client into the most expensive one.
//
// Also: report the viewport in *cells*, derived from the measured cell metrics, and
// coalesce resizes during a divider drag — docs/performance.md § Interaction budgets
// a reflow at one frame, and an uncoalesced drag sends one resize per mouse move
// across two process boundaries.
