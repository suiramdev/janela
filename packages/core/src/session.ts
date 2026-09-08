import type { Accent } from "./accent.ts";
import type { AbsolutePath, Instant, ProjectID, SessionID } from "./identifiers.ts";
import type { SessionLayout } from "./session-layout.ts";
import type { TerminalDescriptor } from "./terminal.ts";

/**
 * The one concept a user has to understand to use Janela.
 *
 * A session is *a directory with terminals in it*. That is the whole idea.
 * Everything else — projects, worktrees, agents, pull requests — hangs off that
 * sentence rather than competing with it.
 *
 * Deliberately **not** modelled here:
 * - An `isWorktree` flag. Worktree-ness is provenance, recorded in `backing`.
 * - Per-session settings trees. Settings are global or per-project; sessions
 *   carry state.
 * - Derived status. "Is this session running?" is a question about its terminals,
 *   answered on demand, never stored.
 */
export interface Session {
  readonly id: SessionID;

  /**
   * The project this session belongs to, or absent for a standalone session.
   *
   * Optional, and that is load-bearing: "just give me a terminal in this folder"
   * is a first-class case, not a degenerate one. A standalone session has no
   * automation, no worktree option and no forge state because it has no project
   * to get them from — nothing else differs.
   */
  projectID?: ProjectID;

  /** User-facing name. Never required to be unique; identity is the `SessionID`. */
  name: string;

  /**
   * The directory terminals open in. This is the session's centre of gravity.
   *
   * It may be a plain folder, a project's own checkout, or a git worktree;
   * `backing` records how it came to exist.
   */
  directory: AbsolutePath;

  /** How this session's directory came about. */
  backing: Backing;

  /**
   * The terminals this session owns, in creation order. Their *arrangement* is
   * `layout`; this is the flat set of things that exist.
   */
  terminals: readonly TerminalDescriptor[];

  /** Tabs and splits over `terminals`. */
  layout: SessionLayout;

  /** Freeform colour tag used in the sidebar. Purely cosmetic, and that is fine. */
  accent: Accent;

  createdAt: Instant;
  lastActiveAt: Instant;

  /** Set when the user pins a session to the top of its group. */
  isPinned: boolean;
}

/**
 * Where a session's directory came from.
 *
 * This is the *only* place worktree-ness enters the model. A worktree-backed
 * session is a normal session with extra provenance — not a separate type, not a
 * separate list, not a separate screen. That asymmetry is the whole product
 * thesis; see docs/product.md.
 */
export type Backing =
  /**
   * A directory the user picked, with no project. No git involvement assumed
   * (though the directory may well be a repo — we detect that opportunistically
   * and never act on it uninvited).
   */
  | { readonly kind: "folder" }
  /**
   * The project's own directory. A "simple" session: no worktree, no isolation,
   * and we must never offer to delete the directory — it is the user's checkout.
   */
  | { readonly kind: "projectDirectory" }
  /** A git worktree. `ownership` decides whether we may remove it. */
  | { readonly kind: "worktree"; readonly binding: WorktreeBinding };

/** The worktree binding, if this session has one. */
export function worktreeOf(session: Session): WorktreeBinding | undefined {
  return session.backing.kind === "worktree" ? session.backing.binding : undefined;
}

/** True when this session is standalone — no project, no automation, no forge. */
export function isStandalone(session: Session): boolean {
  return session.projectID === undefined;
}

/**
 * True when removing the session should also offer to remove a directory from
 * disk.
 *
 * Only ever true for a worktree Janela created. An adopted worktree existed before
 * us and we do not get to destroy it on a hunch; a project directory is the user's
 * checkout and destroying it would be catastrophic.
 */
export function ownsItsDirectory(session: Session): boolean {
  return session.backing.kind === "worktree" && session.backing.binding.ownership === "managed";
}

/**
 * Ties a session's directory to the branch it was cut from.
 *
 * Kept as a small value rather than a first-class entity on purpose: a worktree
 * has no independent life cycle in Janela. It is created with a session and dies
 * with it. Giving it an identity would be the first step back toward a
 * worktree-centric model.
 */
export interface WorktreeBinding {
  /** Branch checked out in the worktree. Absent for a detached HEAD. */
  branch?: string;

  /**
   * The commit the worktree was created at. Useful for detached-HEAD display and
   * for telling the user how far behind they are.
   */
  baseCommit?: string;

  /**
   * Absolute path of the worktree directory as git reports it. Should match the
   * owning session's `directory`; a mismatch means the user moved it behind our
   * back and we should re-resolve rather than guess.
   */
  path: AbsolutePath;

  /** Whether Janela created this worktree, and may therefore offer to delete it. */
  ownership: WorktreeOwnership;

  /**
   * What `.worktreeinclude` copied in, recorded at creation time rather than
   * recomputed at deletion time.
   *
   * This is what lets the removal dialog say "and a 400 MB `node_modules`, and an
   * `.env` that exists nowhere else" instead of "are you sure?". See
   * docs/decisions/0013-worktreeinclude.md.
   */
  includedPaths: readonly string[];
}

/**
 * Who created the worktree, which is the same question as who may delete it.
 *
 * `managed` — Janela created it, so Janela may offer to remove it.
 * `adopted` — it already existed when we found it. We will never delete one of
 * these without an explicit, unambiguous user action.
 */
export type WorktreeOwnership = "managed" | "adopted";

/**
 * The invariants `backing` enforces, checked on decode rather than trusted.
 *
 * | Backing            | `projectID`      | May delete the directory                |
 * | ------------------ | ---------------- | --------------------------------------- |
 * | `folder`           | must be absent   | never                                   |
 * | `projectDirectory` | must be present  | never — it is the user's checkout       |
 * | `worktree`         | must be present  | only when `ownership === "managed"`     |
 *
 * Returns the reasons a session is invalid, empty when it is fine. Used by
 * `@janela/db` on load and by the protocol layer on decode: a session that
 * violates one of these arrived from somewhere that should not have produced it.
 */
export function backingViolations(session: Session): readonly string[] {
  const reasons: string[] = [];
  const hasProject = session.projectID !== undefined;

  switch (session.backing.kind) {
    case "folder":
      if (hasProject) reasons.push("folder backing must not belong to a project");
      break;
    case "projectDirectory":
      if (!hasProject) reasons.push("projectDirectory backing requires a project");
      break;
    case "worktree":
      if (!hasProject) reasons.push("worktree backing requires a project");
      break;
  }

  // Deliberately not checked here: `binding.path` against `directory`. A
  // mismatch means the user moved the worktree, which is something to re-resolve
  // rather than a reason to refuse to load the session — see `WorktreeBinding.path`.
  return reasons;
}
