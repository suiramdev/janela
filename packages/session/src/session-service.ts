import type { AbsolutePath, ProjectID, Session, SessionID, TerminalID } from "@janela/core";
import type { WorktreeRemovalSafety } from "@janela/git";

/**
 * The application's brain: sessions, and the operations that change them.
 *
 * ## Where this runs
 *
 * **In the daemon.** It owns the truth; clients hold mirrors of it and ask for
 * changes over the protocol. Nothing here knows a socket exists, and that is the
 * test of whether the layering is right — `@janela/session` must stay usable with
 * no networking at all, which is exactly how its tests use it.
 *
 * See docs/decisions/0015-daemon-owned-sessions.md.
 */
export interface SessionService {
  /** Every session, both grouped and standalone. */
  readonly sessions: readonly Session[];

  /** Loads persisted state. Called once, early in daemon startup. */
  load(): Promise<void>;

  find(id: SessionID): Session | undefined;
  inProject(id: ProjectID): readonly Session[];

  /** Sessions belonging to no project. A first-class case, not a leftover bucket. */
  readonly standaloneSessions: readonly Session[];

  /**
   * The single entry point for session creation.
   *
   * Worktree creation is *one case of this function*, not a separate feature with
   * its own screen. If this ever grows a second public creation method, something
   * has gone wrong — see docs/product.md § The thesis.
   *
   * Nothing here blocks on a client. The session is persisted and announced before
   * `.worktreeinclude` copying and automation finish, and the client that asked may
   * disconnect mid-flight without changing the outcome.
   */
  createSession(request: SessionCreationRequest): Promise<Session>;

  /** Checks what would be lost, so a client can describe it before asking. */
  removalPlan(id: SessionID): Promise<SessionRemovalPlan>;

  /**
   * Removes a session. Only deletes files when `plan.deletesDirectory` is true
   * *and* the caller explicitly opted in.
   *
   * Runs `sessionTeardown` automation first, bounded by its timeout, and **runs it
   * to completion even if the requesting client disconnects**. A teardown abandoned
   * halfway because a window closed would leave exactly the containers and
   * databases it exists to clean up.
   */
  removeSession(id: SessionID, plan: SessionRemovalPlan): Promise<void>;

  rename(id: SessionID, name: string): Promise<void>;

  /** Starts a configured-but-idle terminal. Attaching never starts anything. */
  startTerminal(id: TerminalID): Promise<void>;
  stopTerminal(id: TerminalID): Promise<void>;
}

/**
 * How the user asked for a session to come into being.
 *
 * One union, five cases, all ending in the same place: a directory with a name and
 * some terminals.
 */
export type SessionCreationRequest =
  /** "Just give me a terminal in this folder." No project, no git, no ceremony. */
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  /** A simple session running in the project's own directory. */
  | { readonly kind: "inProject"; readonly projectID: ProjectID; readonly name?: string }
  /**
   * "Give me a new branch to work on." Creates a worktree behind the scenes, placed
   * according to the project's `worktreeRoot` unless told otherwise.
   */
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly directory?: AbsolutePath;
      readonly name?: string;
    }
  /** "I already have this worktree, manage it too." Adopted, never deletable. */
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  /**
   * "Work on this pull request." Resolves the head branch through the forge CLI,
   * then creates a worktree — never `gh pr checkout`, which would mutate the user's
   * own checkout. See docs/decisions/0012-forge-integration.md.
   */
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };

/**
 * What removing a session will actually do.
 *
 * Specifics rather than a bool, so the confirmation can name what is about to be
 * lost. "Are you sure?" is not a warning.
 */
export interface SessionRemovalPlan {
  /** Terminals that will be killed, across every tab and split. */
  readonly liveTerminalCount: number;

  /**
   * True when Janela created the directory and can therefore offer to delete it.
   * False for a project directory and for an adopted worktree, always.
   */
  readonly canDeleteDirectory: boolean;

  /** Set by the client when the user ticks "also delete the worktree". */
  deletesDirectory: boolean;

  /**
   * Files `.worktreeinclude` copied in, which would go with the directory. Worth
   * naming: an `.env` that exists nowhere else is not recoverable from git.
   */
  readonly includedPaths: readonly string[];

  /** A `sessionTeardown` command will run first, and deletion waits for it. */
  readonly runsTeardownAutomation: boolean;

  /** Reasons deleting would lose work. */
  readonly safety: WorktreeRemovalSafety;
}

// TODO: createSession() — worktree add → `.worktreeinclude` copy →
// `worktreeCreated` automation → `sessionStart` automation → the user's first
// terminal, in that order.
//
// The order is documented in docs/decisions/0013-worktreeinclude.md and
// docs/domain-model.md § AutomationCommand, and scripts depend on it: a
// `worktreeCreated` command that runs before the copy finds no `.env`. Publish
// progress through `StateObserving` at each step, so the session is visible and
// selectable *before* automation starts — the terminal must exist while
// `pnpm install` is still running.
//
// Failure of an automation command is visible and non-fatal: its terminal stays
// open showing the non-zero exit, and the session is still usable. Teardown is the
// one exception, and it is bounded by the command's timeout.
