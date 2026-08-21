/**
 * `@janela/design` — layer 7, client side. Tokens and reusable controls.
 *
 * Knows nothing about projects or sessions; it could be lifted into another app.
 * That constraint is what keeps it a design system rather than a pile of Janela
 * views, and it is why `@janela/core` is deliberately absent from its dependencies.
 */

export * from "./tokens.ts";

// TODO: The reusable controls, as shadcn/ui-derived components over the tokens
// above. The set is small and closed on purpose — a design package that grows a
// component per screen has become the UI package:
//
//   Button, IconButton, Sheet, DisclosureGroup, StatusDot, Field, Segmented,
//   ContextMenu, Tooltip, EmptyState.
//
// Two rules for every one of them:
//   - Keyboard-reachable, with a visible focus ring. Anything reachable only by
//     mouse is a feature we have half-shipped.
//   - No `Ctrl`-based key handling anywhere. `Ctrl` belongs to the program running
//     in the terminal, and a control that swallows it breaks that program — see
//     AGENTS.md § Non-negotiables 4.
//
// This is a *new* seam: the design package previously held tokens and a colour
// catalog, and its controls were never written. Recorded in docs/MIGRATION_MAP.md.
