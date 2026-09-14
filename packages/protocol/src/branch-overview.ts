import { absolutePath, type AbsolutePath } from "@janela/core";

/**
 * The wire form of "which branches does this project have, and where are they
 * checked out".
 *
 * Mirrored rather than shared, for the same reason `SessionCreationIntent`
 * mirrors `SessionCreationRequest` and `SessionRemovalPreview` mirrors
 * `SessionRemovalPlan`: this shape is frozen by the protocol version, and
 * letting `@janela/session` define it would make one of its refactors a breaking
 * change for someone's script. It also keeps this package free of the daemon
 * side of the tree, which a browser client will not have at all.
 *
 * It travels as the `text` reply to a `projectBranches` request rather than as
 * its own `DaemonMessage`, because a reply has to be correlated by `RequestID`
 * and the three reply variants are what a client's `request()` settles on.
 */

/** One checkout of the project's repository. The wire mirror of `GitWorktree`. */
export interface BranchWorktree {
  readonly directory: AbsolutePath;
  /** Absent when detached. */
  readonly branch?: string;
  /** The repository's own checkout, as opposed to a linked worktree. */
  readonly isMain: boolean;
}

/**
 * What a client needs to offer "which branch, and where": every local branch,
 * and every checkout that already exists.
 *
 * Both lists rather than a branch-to-worktree map, because a worktree may be
 * detached and therefore name no branch, and a branch may be checked out
 * nowhere. A map would have to invent a key for the first and lose the second.
 */
export interface BranchOverview {
  readonly branches: readonly string[];
  readonly worktrees: readonly BranchWorktree[];
}

/**
 * Exactly the fields above, and nothing a caller's object happens to carry
 * alongside them: the daemon passes its own overview here, whose worktrees are
 * structurally wider than the wire type.
 */
export function serializeBranchOverview(overview: BranchOverview): string {
  return JSON.stringify({
    branches: [...overview.branches],
    worktrees: overview.worktrees.map((worktree) => ({
      directory: worktree.directory,
      // Omitted rather than set to null: a detached worktree names no branch,
      // and `exactOptionalPropertyTypes` makes that distinction load-bearing on
      // the way back in.
      ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
      isMain: worktree.isMain,
    })),
  });
}

/**
 * Field by field, because the wire has no type system and this text crossed it.
 *
 * @throws {TypeError} for anything that is not a fully-populated overview. A
 *   peer that sends a worktree with no directory is not speaking this protocol,
 *   and a half-checked overview is how "check this branch out here" becomes a
 *   session pointing at `undefined`.
 */
export function parseBranchOverview(text: string): BranchOverview {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("branch overview is not JSON");
  }
  const overview = asObject(value, "branch overview");
  return {
    branches: names(overview["branches"]),
    worktrees: worktreesOf(overview["worktrees"]),
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

function name(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not a string`);
  return value;
}

function names(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("branches is not an array");
  return value.map((entry: unknown) => name(entry, "branches holds a non-string"));
}

function worktreesOf(value: unknown): readonly BranchWorktree[] {
  if (!Array.isArray(value)) throw new TypeError("worktrees is not an array");
  return value.map((entry: unknown) => {
    const worktree = asObject(entry, "worktree");
    const branch = worktree["branch"];
    return {
      directory: directoryOf(worktree["directory"]),
      ...(branch === undefined ? {} : { branch: name(branch, "worktree.branch") }),
      isMain: flag(worktree["isMain"], "worktree.isMain"),
    };
  });
}

/**
 * Validated rather than re-branded: this string becomes a session's working
 * directory, and `absolutePath` is the one place that decides what one is. Its
 * own refusal is an `Error`, so the check is repeated here to keep every
 * malformed-overview failure a `TypeError`, as `parseRemovalPlan`'s are.
 */
function directoryOf(value: unknown): AbsolutePath {
  const raw = name(value, "worktree.directory");
  if (!raw.startsWith("/")) throw new TypeError("worktree.directory is not absolute");
  return absolutePath(raw);
}
