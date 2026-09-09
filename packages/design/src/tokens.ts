/**
 * Janela's visual constants.
 *
 * The bar for adding something here: it is used in at least two places, or it
 * encodes a decision someone would otherwise get wrong. Everything else is a
 * literal at the call site, where it is easier to read.
 *
 * Colours are semantic, not literal. There is no `janela.blue`, because a name like
 * that tells you nothing about when to use it and guarantees drift.
 *
 * ## What changed with the WebView, and what did not
 *
 * The tokens are the same. Where they resolve moved: they were an asset catalog that
 * adapted to light/dark and Increase Contrast without code branching, and they are
 * now CSS custom properties that do the same through `prefers-color-scheme` and
 * `prefers-contrast`. The rule that no view branches on appearance is unchanged, and
 * is the reason this is a token file rather than two palettes.
 */

/** The 4-point grid everything snaps to. */
export const GRID_UNIT = 4;

/**
 * Sidebar bounds. Below the minimum, session names truncate uselessly — and they sit
 * indented under a project, so they start further right than the width alone
 * suggests.
 */
export const SIDEBAR_WIDTH = { minimum: 180, ideal: 240, maximum: 400 } as const;

/** Corner radii, matched to the platform's control shapes. */
export const CORNER_RADIUS = { small: 6, medium: 10 } as const;

/**
 * Terminal padding. Asymmetric on purpose: the extra leading space keeps text off
 * the window edge without making the first column look indented.
 */
export const TERMINAL_INSETS = { top: 8, leading: 10, bottom: 8, trailing: 6 } as const;

/**
 * Semantic colours, as CSS custom property names.
 *
 * Every one is defined once in `tokens.css` for light, dark and increased-contrast,
 * so no component branches on appearance.
 */
export const COLOR = {
  /** Background behind terminal content. */
  terminalBackground: "--janela-terminal-background",
  /** Badge on a terminal, and on the session button that contains it. */
  attention: "--janela-attention",
  /** Indicator for a running terminal. */
  running: "--janela-running",
  /**
   * Text and glyphs for a terminal that exited non-zero, including a failed
   * automation command — whose terminal stays open showing exactly why.
   */
  failure: "--janela-failure",
} as const;

/**
 * The terminal font stack.
 *
 * User-overridable in Settings; this is only the default. SF Mono first because it
 * ships with macOS, has the coverage agents need, and hints well at small sizes —
 * then a stack, because a WebView on another platform has to render something.
 */
export const TERMINAL_FONT_STACK =
  '"SF Mono", "Menlo", "DejaVu Sans Mono", ui-monospace, monospace';

/**
 * Motion.
 *
 * Every transition must respect `prefers-reduced-motion`, which is the web's
 * spelling of the Reduce Motion setting the native app honoured. A component that
 * animates unconditionally is a bug, not a flourish.
 */
export const MOTION = { fast: 120, medium: 200 } as const;
