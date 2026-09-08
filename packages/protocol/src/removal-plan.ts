/**
 * The wire form of a session removal plan.
 *
 * Mirrored rather than shared, for the same reason `SessionCreationIntent`
 * mirrors `SessionCreationRequest`: this shape is frozen by the protocol version,
 * and letting `@janela/session` define it would make one of its refactors a
 * breaking change for someone's script. It also keeps this package free of a
 * dependency on the daemon side of the tree, which it may not have at all.
 *
 * It travels as the `text` reply to a `removalPlan` request rather than as its own
 * `DaemonMessage`, because a reply has to be correlated by `RequestID` and the
 * three reply variants are what a client's `request()` settles on.
 */

/**
 * Reasons deleting a session's directory would lose work.
 *
 * The wire mirror of `WorktreeRemovalSafety` in `@janela/git`. An explicit list
 * rather than a bool, so a confirmation can name what is about to go.
 */
export interface RemovalSafety {
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
  readonly isLocked: boolean;
  readonly hasRunningSessions: boolean;
}

/** What removing a session will do. The wire mirror of `SessionRemovalPlan`. */
export interface SessionRemovalPreview {
  /** Terminals that will be killed, across every tab and split. */
  readonly liveTerminalCount: number;
  /** True when Janela created the directory and can therefore offer to delete it. */
  readonly canDeleteDirectory: boolean;
  /** What the daemon would do today. The client sends its own answer back with `removeSession`. */
  readonly deletesDirectory: boolean;
  /** Files `.worktreeinclude` copied in, which would go with the directory. */
  readonly includedPaths: readonly string[];
  /** A `sessionTeardown` command will run first, and deletion waits for it. */
  readonly runsTeardownAutomation: boolean;
  readonly safety: RemovalSafety;
}

/**
 * Exactly the fields above, and nothing a caller's object happens to carry
 * alongside them: the daemon passes its own `SessionRemovalPlan` here, which is
 * structurally wider than the wire type.
 */
export function serializeRemovalPlan(plan: SessionRemovalPreview): string {
  return JSON.stringify({
    liveTerminalCount: plan.liveTerminalCount,
    canDeleteDirectory: plan.canDeleteDirectory,
    deletesDirectory: plan.deletesDirectory,
    includedPaths: [...plan.includedPaths],
    runsTeardownAutomation: plan.runsTeardownAutomation,
    safety: {
      hasUncommittedChanges: plan.safety.hasUncommittedChanges,
      hasUntrackedFiles: plan.safety.hasUntrackedFiles,
      hasUnpushedCommits: plan.safety.hasUnpushedCommits,
      isLocked: plan.safety.isLocked,
      hasRunningSessions: plan.safety.hasRunningSessions,
    },
  });
}

/**
 * Field by field, because the wire has no type system and this text crossed it.
 *
 * @throws {TypeError} for anything that is not a fully-populated preview. A peer
 *   that sends a plan with a string count is not speaking this protocol, and a
 *   half-checked plan is how "delete the directory" becomes undefined.
 */
export function parseRemovalPlan(text: string): SessionRemovalPreview {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("removal plan is not JSON");
  }
  const plan = asObject(value, "removal plan");
  return {
    liveTerminalCount: count(plan["liveTerminalCount"], "liveTerminalCount"),
    canDeleteDirectory: flag(plan["canDeleteDirectory"], "canDeleteDirectory"),
    deletesDirectory: flag(plan["deletesDirectory"], "deletesDirectory"),
    includedPaths: paths(plan["includedPaths"]),
    runsTeardownAutomation: flag(plan["runsTeardownAutomation"], "runsTeardownAutomation"),
    safety: safetyOf(plan["safety"]),
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} is not a boolean`);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} is not a count`);
  }
  return value;
}

function paths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("includedPaths is not an array");
  return value.map((entry: unknown) => {
    if (typeof entry !== "string") throw new TypeError("includedPaths holds a non-string");
    return entry;
  });
}

function safetyOf(value: unknown): RemovalSafety {
  const safety = asObject(value, "safety");
  return {
    hasUncommittedChanges: flag(safety["hasUncommittedChanges"], "safety.hasUncommittedChanges"),
    hasUntrackedFiles: flag(safety["hasUntrackedFiles"], "safety.hasUntrackedFiles"),
    hasUnpushedCommits: flag(safety["hasUnpushedCommits"], "safety.hasUnpushedCommits"),
    isLocked: flag(safety["isLocked"], "safety.isLocked"),
    hasRunningSessions: flag(safety["hasRunningSessions"], "safety.hasRunningSessions"),
  };
}
