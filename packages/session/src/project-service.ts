import type { AbsolutePath, Project, ProjectID, ProjectSettings } from "@janela/core";

/**
 * Projects, and the operations that change them.
 *
 * Runs in the daemon alongside `SessionService`, and separate from it because the
 * two answer different questions: this one owns "what has the user added and how is
 * it configured", the other owns "what is the user working on".
 */
export interface ProjectService {
  readonly projects: readonly Project[];

  /**
   * Loads persisted projects during daemon startup.
   *
   * Database work only: no git, no `PATH` probing, no forge detection. Those refresh
   * in the background once the daemon is serving, because the first client to
   * connect is waiting on this.
   */
  load(): Promise<void>;

  find(id: ProjectID): Project | undefined;

  /**
   * Registers a directory as a project.
   *
   * The **client** chose this directory through a native file dialog, and hands us
   * the path. The daemon never discovers directories on its own and never scans the
   * home directory — that rule is what keeps macOS permission prompts attributed to
   * the app the user clicked rather than to a background binary they have never
   * heard of. See docs/decisions/0017-daemon-lifecycle.md § TCC attribution.
   *
   * Detecting whether the directory is a git repository is opportunistic and never
   * blocks: a plain folder is a perfectly good project that simply cannot offer
   * worktree-backed sessions.
   */
  addProject(request: {
    readonly directory: AbsolutePath;
    readonly name?: string;
  }): Promise<Project>;

  /**
   * Removes a project **and everything in it**.
   *
   * Deleting a project deletes its sessions, so the caller must have asked the
   * removal question for each one that owns a directory. This method does not ask;
   * that is the client's job, and it has already been done by the time we are
   * called.
   */
  removeProject(id: ProjectID): Promise<void>;

  /**
   * Replaces a project's settings — automation commands, worktree placement, forge
   * preference.
   */
  updateSettings(id: ProjectID, settings: ProjectSettings): Promise<void>;
}

// TODO: addProject() — create the record, announce it, then refresh `git` in the
// background: remote URL, default branch, and forge detection from the remote host.
// The announce must come first. A user who just picked a directory should see the
// project appear immediately, not after a `git remote -v` on a cold NFS mount.
