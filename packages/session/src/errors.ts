import type { AbsolutePath, LaunchProfileID, ProjectID, SessionID, TerminalID } from "@janela/core";
import { UserFacingError } from "@janela/support";

/**
 * The brain's user-facing failures.
 *
 * Every one carries a `summary` a person can act on, because the rule is that an
 * error is either shown or logged and never both raw (AGENTS.md § errors). The
 * `message` is for the log and may name an id; a `summary` never does, and no
 * message here carries a filesystem path — a path in a headline is how a dialog
 * turns into a bug report.
 */

/**
 * A `ProjectID` that no longer resolves.
 *
 * Reachable without a client bug: two windows, one removes the project while the
 * other still shows it.
 */
export class UnknownProject extends UserFacingError {
  override readonly summary = "That project no longer exists.";
  readonly project: ProjectID;

  constructor(project: ProjectID) {
    super(`project ${project} not found`);
    this.project = project;
  }
}

export class UnknownSession extends UserFacingError {
  override readonly summary = "That session no longer exists.";
  readonly session: SessionID;

  constructor(session: SessionID) {
    super(`session ${session} not found`);
    this.session = session;
  }
}

export class UnknownTerminal extends UserFacingError {
  override readonly summary = "That terminal no longer exists.";
  readonly terminal: TerminalID;

  constructor(terminal: TerminalID) {
    super(`terminal ${terminal} not found`);
    this.terminal = terminal;
  }
}

/**
 * The directory is already a project.
 *
 * The path stays out of `message`: the client picked it and can name it, and a log
 * line does not need the user's directory layout.
 */
export class ProjectAlreadyAdded extends UserFacingError {
  override readonly summary = "This folder is already a project.";
  readonly directory: AbsolutePath;

  constructor(directory: AbsolutePath) {
    super("project directory already registered");
    this.directory = directory;
  }
}

/** A worktree session was asked for in a project that is not a repository. */
export class WorktreesUnsupported extends UserFacingError {
  override readonly summary =
    "This project isn't a git repository, so it can't have worktree sessions.";
  readonly project: ProjectID;

  constructor(project: ProjectID) {
    super(`project ${project} is not a git repository`);
    this.project = project;
  }
}

/**
 * A split was asked for in a pane tree that is already `MAXIMUM_PANE_DEPTH` deep.
 *
 * The bound is not a style preference — see `MAXIMUM_PANE_DEPTH` — so refusing is
 * the honest answer rather than silently opening a tab instead.
 */
export class LayoutTooDeep extends UserFacingError {
  override readonly summary =
    "This pane cannot be split again: the layout is already as deep as it goes.";
  readonly session: SessionID;

  constructor(session: SessionID) {
    super(`session ${session} layout is at maximum pane depth`);
    this.session = session;
  }
}

/**
 * `fromPullRequest` before the forge integration exists.
 *
 * Thrown at the top of `createSession` rather than left as a silent no-op, so the
 * one branch that has to change when the forge integration lands is impossible to
 * miss.
 */
export class PullRequestsNotSupported extends UserFacingError {
  override readonly summary = "Sessions from pull requests aren't supported yet.";

  constructor() {
    super("fromPullRequest not supported until the forge integration lands (#33)");
  }
}

/**
 * A launch profile's executable is not on the captured `PATH`.
 *
 * A profile the user cannot run is normally hidden rather than shown broken; this
 * is the case where they started it anyway — a profile configured before the tool
 * was uninstalled, or a session restored on a different machine.
 */
export class LaunchProfileUnavailable extends UserFacingError {
  override readonly summary: string;
  readonly profileName: string;

  constructor(profileName: string) {
    super("launch profile executable not found on PATH", {
      recoverySuggestion: "Install it, or start a plain shell instead.",
    });
    this.summary = `${profileName} isn't installed.`;
    this.profileName = profileName;
  }
}

/** A profile id that no longer resolves: two settings windows, one deletion. */
export class UnknownLaunchProfile extends UserFacingError {
  override readonly summary = "That launch profile no longer exists.";
  readonly profile: LaunchProfileID;

  constructor(profile: LaunchProfileID) {
    super(`launch profile ${profile} not found`);
    this.profile = profile;
  }
}

/**
 * Deleting a built-in was asked for and refused.
 *
 * Built-ins are the profiles Janela ships; a user who wants a different Claude
 * Code copies it and edits the copy, which is also what keeps the seed idempotent
 * — a deleted built-in would come back on the next daemon start and look like a
 * bug.
 */
export class BuiltInProfileProtected extends UserFacingError {
  override readonly summary = "Built-in profiles can't be deleted.";
  readonly profile: LaunchProfileID;

  constructor(profile: LaunchProfileID) {
    super("built-in launch profile cannot be removed", {
      recoverySuggestion: "Edit it instead, or copy it and edit the copy.",
    });
    this.profile = profile;
  }
}

/** `adoptWorktree` for a directory git does not list as a worktree of the project. */
export class NotAWorktree extends UserFacingError {
  override readonly summary = "That folder isn't a worktree of this project.";
  readonly directory: AbsolutePath;

  constructor(directory: AbsolutePath) {
    super("directory is not a worktree of the project");
    this.directory = directory;
  }
}
