/**
 * `@janela/design` — layer 7, client side. The visual constants.
 *
 * Knows nothing about projects or sessions; it could be lifted into another app.
 * That constraint is what keeps it a design system rather than a pile of Janela
 * views, and it is why `@janela/core` is deliberately absent from its dependencies.
 *
 * **It holds tokens, and no components.** It was scaffolded to hold a closed set of
 * ten shadcn/ui-derived controls; the app shipped without them, and every screen
 * built its own markup over these tokens instead. Rather than write ten components
 * no screen asks for, the seam is retired: the tokens are the shared thing, and
 * `@janela/ui` owns the controls that turned out to be Janela-specific.
 *
 * If a control is ever genuinely shared, it lands here — keyboard-reachable, with a
 * visible focus ring, and with no `Ctrl`-based key handling. `Ctrl` belongs to the
 * program running in the terminal (AGENTS.md § Non-negotiables 4).
 */

export * from "./tokens.ts";
