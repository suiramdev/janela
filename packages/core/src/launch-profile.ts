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
   * than rendering nothing.
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

// MARK: - Availability

/**
 * Which profiles can actually be started, keyed by id.
 *
 * This is the one fact about a profile that `@janela/core` cannot compute: it
 * depends on the user's real `PATH`, captured from their login shell in the
 * daemon (`resolveShellEnvironment`, `@janela/session`). So the daemon computes
 * this record and sends it; the client filters on it and never probes anything
 * itself — a client cannot spawn a process, and the layering gate makes that
 * structural.
 *
 * **An absent entry means hidden.** Not "assume available": a profile shown in a
 * picker and then failing to start is exactly the "shown broken" outcome the
 * product forbids, and the login-shell built-in is available by rule, so the
 * picker is never empty while we wait to be told.
 */
export type LaunchProfileAvailability = Readonly<Record<LaunchProfileID, boolean>>;

/**
 * True when this profile means "the user's login shell", which is what an empty
 * `command` is defined to mean. Named because `command[0] === undefined` at a
 * call site explains the mechanism and not the rule.
 */
export function usesLoginShell(profile: Pick<LaunchProfile, "command">): boolean {
  return profile.command[0] === undefined;
}

/**
 * Whether an executable has to be looked up on `PATH`.
 *
 * A name containing a separator is a path, and is used as written — the same rule
 * `resolveTerminalLaunch` applies, which deliberately does **not** stat it. Two
 * copies of this predicate would be two chances for a profile to be hidden here
 * and then fail to launch there.
 */
export function needsPathLookup(executable: string): boolean {
  return !executable.includes("/");
}

/**
 * Resolves availability for `profiles` against a synchronous "is this on `PATH`"
 * predicate.
 *
 * The predicate is injected because the lookup is I/O and this package has none.
 * The daemon passes one closed over the captured environment; a test passes a set
 * membership. Every profile gets an entry, so the record distinguishes "we looked
 * and it is missing" from "nobody has said".
 */
export function profileAvailability(
  profiles: readonly LaunchProfile[],
  isOnPath: (executable: string) => boolean,
): LaunchProfileAvailability {
  const availability: Record<LaunchProfileID, boolean> = {};
  for (const profile of profiles) {
    const executable = profile.command[0];
    availability[profile.id] =
      executable === undefined || !needsPathLookup(executable) || isOnPath(executable);
  }
  return availability;
}

/**
 * Whether this profile may be offered to the user.
 *
 * The login shell is always available: resolving it needs no `PATH` lookup, only
 * the login shell the daemon already captured. A path-bearing `argv[0]` is
 * likewise taken at its word, because launching it does the same.
 */
export function isProfileAvailable(
  profile: LaunchProfile,
  availability: LaunchProfileAvailability,
): boolean {
  const executable = profile.command[0];
  if (executable === undefined || !needsPathLookup(executable)) return true;
  return availability[profile.id] ?? false;
}

/**
 * The profiles a picker may show, in the order given.
 *
 * Order is preserved rather than chosen: which profiles a menu shows and in what
 * sequence is a presentation decision made by the view that shows them, and a
 * picker that reorders itself as binaries appear and disappear would move the
 * user's target between keystrokes.
 */
export function availableProfiles(
  profiles: readonly LaunchProfile[],
  availability: LaunchProfileAvailability,
): readonly LaunchProfile[] {
  return profiles.filter((profile) => isProfileAvailable(profile, availability));
}
