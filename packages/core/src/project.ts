import type { Accent } from "./accent.ts";
import type {
  AbsolutePath,
  AutomationID,
  Instant,
  LaunchProfileID,
  ProjectID,
} from "./identifiers.ts";

/**
 * A directory the user added, so Janela can offer to do things in it.
 *
 * A project is a container *and* an index. It contains sessions — deleting a
 * project deletes them — and it indexes a repository so that "new branch" is one
 * step instead of a file picker.
 *
 * Deliberately **not** modelled here:
 * - Nested projects, folders, tags. The sidebar is two levels deep, always.
 * - A separate `Repository` type. A project either has a `git` descriptor or it
 *   does not; a plain folder is a perfectly good project that simply cannot offer
 *   worktree-backed sessions.
 *
 * See docs/decisions/0009-projects-sessions-terminals.md.
 */
export interface Project {
  readonly id: ProjectID;

  /**
   * User-facing name. Defaults to the directory name, always editable, never
   * required to be unique — humans are bad at unique names and we do not need it.
   */
  name: string;

  /**
   * The project's own directory: a repository's main checkout, or just a folder.
   *
   * Note this is git's *main worktree*, not the common dir. Sessions backed by
   * `projectDirectory` run here; worktree-backed sessions are cut from here.
   */
  directory: AbsolutePath;

  /** Git facts about `directory`, or absent when it is not a repository. */
  git?: GitDescriptor;

  /** The only per-scope settings that exist. Everything else is global. */
  settings: ProjectSettings;

  /** Freeform colour tag used in the sidebar. Purely cosmetic, and that is fine. */
  accent: Accent;

  /**
   * Whether the project's session list is expanded in the sidebar.
   *
   * Collapsing must do no work: this is a boolean on a value, and expanding a
   * project may never trigger git, disk, or forge reads. See
   * docs/performance.md § Interaction.
   */
  isExpanded: boolean;

  addedAt: Instant;
}

/** True when this project can offer worktree-backed sessions. */
export function supportsWorktrees(project: Project): boolean {
  return project.git !== undefined;
}

// MARK: - Git

/**
 * Cached git facts about a project's directory.
 *
 * Every field here is **for display and for preselecting a sheet**. Git is always
 * the source of truth: we re-read rather than reconcile, because a cache that
 * disagrees with git is worse than no cache at all.
 */
export interface GitDescriptor {
  /** The `origin` remote URL, when there is one. */
  remoteURL?: string;

  /**
   * Cached at registration time so the "new branch" sheet can preselect sensibly
   * without shelling out. Refreshed opportunistically, never trusted for
   * correctness.
   */
  defaultBranch?: string;

  /**
   * Which forge `remoteURL` points at, if we recognise it.
   *
   * Detection is a string match on the host, not a network call. Whether the
   * integration actually *works* additionally depends on the user having `gh` or
   * `glab` installed and logged in — see
   * docs/decisions/0012-forge-integration.md.
   */
  forge?: Forge;
}

/**
 * A code-hosting service Janela can read state from, through the user's own CLI.
 *
 * We never hold a credential for either of these.
 */
export type Forge = "gitHub" | "gitLab";

/**
 * The binary we shell out to. Absence on `PATH` means the feature is absent, not
 * broken.
 */
export function forgeExecutable(forge: Forge): string {
  return forge === "gitHub" ? "gh" : "glab";
}

// MARK: - Settings

/**
 * Per-project settings.
 *
 * These earn their place because a project is where the differences actually
 * live: one repository needs `pnpm install`, another needs a Python venv, a third
 * needs neither. Per-*session* settings do not earn their place, and adding them
 * needs an ADR.
 */
export interface ProjectSettings {
  /** Where worktrees Janela creates are placed. */
  worktreeRoot: WorktreeRoot;

  /**
   * Commands run on project lifecycle events, in order, each in its own visible
   * terminal. See docs/decisions/0014-project-automation.md.
   */
  automation: readonly AutomationCommand[];

  /** Launch profile used for a new session's first terminal. Absent means the global default. */
  defaultProfileID?: LaunchProfileID;

  /** Whether to read pull-request and check state for this project's sessions. */
  isForgeEnabled: boolean;
}

/** Where a project's managed worktrees are created. */
export type WorktreeRoot =
  /**
   * A `.worktrees/<slug>` directory beside the repository. Keeps `~/` tidy and
   * keeps relative paths short, which matters because build tools embed them.
   */
  | { readonly kind: "siblingDirectory" }
  /** A directory the user chose. */
  | { readonly kind: "custom"; readonly directory: AbsolutePath };

// MARK: - Automation

/**
 * A command Janela runs on the user's behalf when something happens to a session.
 *
 * Two properties of this type are load-bearing and neither is obvious:
 *
 * 1. It lives in **Janela's database**, never in the repository. A committed file
 *    that runs commands makes cloning a repo a code-execution vector.
 * 2. `command` is an **argv array**, not a shell string — same rule as
 *    `LaunchProfile`, same reason. A user who wants a shell writes
 *    `["zsh", "-lc", "…"]` and has chosen that explicitly.
 *
 * See docs/decisions/0014-project-automation.md.
 */
export interface AutomationCommand {
  readonly id: AutomationID;
  event: AutomationEvent;
  /** Executable plus arguments. Never handed to `sh -c`. */
  command: readonly string[];
  /**
   * Off by default when created from a template, so nothing runs because the user
   * clicked "add" to read the placeholder.
   */
  isEnabled: boolean;
  /**
   * How long deletion waits for a `sessionTeardown` command, in seconds. Ignored
   * for the other events, which never block anything.
   */
  timeoutSeconds: number;
}

/**
 * The lifecycle events a project can attach commands to.
 *
 * Three, and adding a fourth needs an ADR. This is not a task runner: there is no
 * scheduling, no retry, no dependency graph, and no conditional execution.
 */
export type AutomationEvent =
  /**
   * A managed worktree exists and `.worktreeinclude` has finished copying.
   * Ordering matters here: scripts depend on their `.env` already being present.
   */
  | "worktreeCreated"
  /**
   * A session in this project is opened for the first time. Once per session, not
   * once per app launch — restarting Janela does not re-run `pnpm dev`.
   */
  | "sessionStart"
  /**
   * The user asked to delete the session. The only blocking event, bounded by
   * `AutomationCommand.timeoutSeconds`.
   */
  | "sessionTeardown";

export const AUTOMATION_EVENTS: readonly AutomationEvent[] = [
  "worktreeCreated",
  "sessionStart",
  "sessionTeardown",
];
