import type { AbsolutePath, LaunchProfileID, ProjectID, SessionID, TerminalID } from "@janela/core";
import { UserFacingError, type Presentation } from "@janela/support";
import { Match } from "effect";

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

export class ProjectAlreadyAdded extends UserFacingError {
  override readonly summary = "This folder is already a project.";
  readonly directory: AbsolutePath;

  constructor(directory: AbsolutePath) {
    super("project directory already registered");
    this.directory = directory;
  }
}

export class WorktreesUnsupported extends UserFacingError {
  override readonly summary =
    "This project isn't a git repository, so it can't have worktree sessions.";
  readonly project: ProjectID;

  constructor(project: ProjectID) {
    super(`project ${project} is not a git repository`);
    this.project = project;
  }
}

export class LayoutTooDeep extends UserFacingError {
  override readonly summary =
    "This pane cannot be split again: the layout is already as deep as it goes.";
  readonly session: SessionID;

  constructor(session: SessionID) {
    super(`session ${session} layout is at maximum pane depth`);
    this.session = session;
  }
}

export class PullRequestsNotSupported extends UserFacingError {
  override readonly summary = "Sessions from pull requests aren't supported yet.";

  constructor() {
    super("fromPullRequest not supported until the forge integration lands (#33)");
  }
}

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

export class UnknownLaunchProfile extends UserFacingError {
  override readonly summary = "That launch profile no longer exists.";
  readonly profile: LaunchProfileID;

  constructor(profile: LaunchProfileID) {
    super(`launch profile ${profile} not found`);
    this.profile = profile;
  }
}

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

export class NotAWorktree extends UserFacingError {
  override readonly summary = "That folder isn't a worktree of this project.";
  readonly directory: AbsolutePath;

  constructor(directory: AbsolutePath) {
    super("directory is not a worktree of the project");
    this.directory = directory;
  }
}

export class DirectoryUnreadable extends UserFacingError {
  override readonly summary = "Couldn't open that folder.";
  readonly directory: AbsolutePath;
  readonly code: string;

  constructor(directory: AbsolutePath, code: string) {
    super(`directory unreadable: ${code}`, directoryPresentation(code));
    this.directory = directory;
    this.code = code;
  }
}

function directoryPresentation(code: string): Presentation {
  return Match.value(code).pipe(
    Match.when("ENOENT", () => ({ reason: "It doesn't exist." })),
    Match.when("ENOTDIR", () => ({ reason: "It isn't a folder." })),
    Match.whenOr("EACCES", "EPERM", () => ({
      reason: "You don't have permission to read it.",
    })),
    Match.orElse(() => ({})),
  );
}
