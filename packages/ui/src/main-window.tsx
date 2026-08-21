import type { ReactElement } from "react";

/**
 * The main window: projects and sessions on the left, terminals on the right.
 *
 * ## Structure
 *
 * ```text
 * ┌──────────────────┬────────────────────────────┐
 * │ ▸ scratch        │ ▸ agent  server  shell  +  │
 * │                  ├────────────────────────────┤
 * │ ▼ janela         │                │           │
 * │    • main        │    terminal    │ terminal  │
 * │    • fix/pty ●   │                │           │
 * │ ▸ api            │                │           │
 * └──────────────────┴────────────────────────────┘
 *   projects collapse    tabs, then splits
 *   sessions are buttons
 * ```
 *
 * That is the entire application. There is no inspector, no bottom panel, no
 * activity bar, and adding one should require an argument that survives
 * docs/product.md § Non-goals.
 *
 * ## What this view is looking at
 *
 * A **mirror**. The sessions below live in `janelad`; these stores hold the last
 * state it sent. When the connection drops, the mirror is still rendered — marked
 * stale — because the terminals themselves are unaffected and the user's work is
 * still running. See docs/decisions/0015-daemon-owned-sessions.md.
 */
export function MainWindow(): ReactElement {
  throw new Error(`not implemented: MainWindow`);
}

/**
 * Two levels, and never a third: standalone sessions, then collapsible projects with
 * their sessions inside.
 *
 * Deliberately a flat list of buttons rather than a recursive tree component. The
 * shape is fixed at two levels by
 * docs/decisions/0009-projects-sessions-terminals.md, and a recursive view would
 * quietly permit the thing that ADR forbids.
 */
export function Sidebar(): ReactElement {
  throw new Error(`not implemented: Sidebar`);
}

// TODO: Sidebar — standalone sessions in an unlabelled top section, then one
// disclosure group per project bound to `Project.isExpanded`. Expanding must not
// trigger any work: it is a boolean on a value, and if expanding ever needs to read
// git, load sessions, or refresh anything, the laziness rule has been broken
// somewhere upstream. See docs/performance.md § Interaction.
//
// Session rows show status derived from `SessionStore.terminalStates`, which is what
// the daemon reported. Never infer it locally.
//
// The fuzzy jump list (⌘⇧O) belongs here too: with 40 sessions the sidebar is long
// by design, and the jump list is what keeps "every session is one keystroke away"
// true at that size.

/** Tab strip, split view, and the focused terminal. */
export function SessionDetail(props: { readonly sessionID: string }): ReactElement {
  void props;
  throw new Error(`not implemented: SessionDetail`);
}

// TODO: SessionDetail — a tab strip over `session.layout.tabs`, then a recursive pane
// view over `SessionLayout.Pane` with draggable dividers, then a TerminalSurface per
// pane.
//
// Attaching a pane sends `attach`; the daemon replies with a full repaint, so there
// is no separate "load scrollback" step and no loading state to design.
//
// Divider drags must coalesce resizes — one resize per frame, not one per mouse
// move, because each one crosses two process boundaries and a `TIOCSWINSZ` with a
// SIGWINCH at the end of it.
