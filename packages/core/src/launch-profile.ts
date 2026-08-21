import type { LaunchProfileID } from "./identifiers.ts";

/**
 * A named thing you can start in a terminal.
 *
 * This is Janela's entire "agent integration" surface, and that is intentional.
 * We do not wrap Claude Code, parse Codex's output, or model an agent's task
 * graph. We make it one keystroke to start the tool the user already has, in the
 * right directory, with a sensible title. See docs/product.md § Non-goals.
 */
export interface LaunchProfile {
  readonly id: LaunchProfileID;

  /** Shown in the new-session menu, e.g. "Claude Code". */
  name: string;

  /**
   * Icon name.
   *
   * Was an SF Symbol name; the client is now a WebView, so it names a Lucide icon
   * from `@janela/design` instead. The field is presentational either way, and a
   * name the client does not recognise falls back to the terminal glyph rather
   * than rendering nothing. See docs/decisions/0023-macos-first-portable.md.
   */
  iconName: string;

  /**
   * Executable plus arguments. Not a shell string: we never hand user input to
   * `sh -c`, so there is no quoting bug class here.
   *
   * An empty `command` means "the user's login shell", resolved at launch.
   */
  command: readonly string[];

  /**
   * Extra environment on top of the inherited one. Values are not secrets;
   * anything sensitive should come from the user's own shell configuration.
   */
  environment: Readonly<Record<string, string>>;

  /**
   * Whether this profile counts as an agent for UI purposes (distinct tab icon,
   * inclusion in "notify me when agents finish"). Purely presentational, and it
   * grants no special behaviour, because agents get no special behaviour.
   */
  isAgent: boolean;

  /** Profiles Janela ships with cannot be deleted, only overridden by copying. */
  isBuiltIn: boolean;
}

/**
 * The profiles Janela offers out of the box.
 *
 * Ids are assigned at seed time rather than baked in here, because a hardcoded id
 * would collide with a user's own copy of a built-in.
 *
 * These are *suggestions, not integrations*: if the binary is not on the user's
 * `PATH` the profile is hidden rather than shown broken. Adding a new entry here
 * must never require code changes elsewhere.
 */
export const BUILT_IN_PROFILES: readonly Omit<LaunchProfile, "id">[] = [
  {
    name: "Shell",
    iconName: "terminal",
    command: [],
    environment: {},
    isAgent: false,
    isBuiltIn: true,
  },
  {
    name: "Claude Code",
    iconName: "sparkles",
    command: ["claude"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
  {
    name: "Codex",
    iconName: "code",
    command: ["codex"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
  {
    name: "OpenCode",
    iconName: "box",
    command: ["opencode"],
    environment: {},
    isAgent: true,
    isBuiltIn: true,
  },
];
