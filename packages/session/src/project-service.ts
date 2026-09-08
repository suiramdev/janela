import { realpath } from "node:fs/promises";
import { basename } from "node:path";

import type {
  AbsolutePath,
  Forge,
  GitDescriptor,
  Project,
  ProjectID,
  ProjectSettings,
} from "@janela/core";
import { newProjectID, now } from "@janela/core";
import type { ProjectRepository } from "@janela/db";
import type { GitRunning } from "@janela/git";
import type { Logger } from "@janela/support";

import { ProjectAlreadyAdded, UnknownProject } from "./errors.ts";
import { silentLogger } from "./silent-logger.ts";
import type { StateObserving } from "./state-observing.ts";

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

/**
 * What the project service needs from the session side when a project goes.
 *
 * A one-method interface rather than a reference to `SessionService`, so the two
 * services compose without a cycle and so this package's tests can remove a
 * project without a session service at all.
 */
export interface ProjectRemovalObserving {
  /**
   * Stops the project's terminals and forgets its sessions.
   *
   * Called *before* the row is deleted: the sessions cascade with it, and a live
   * terminal in a directory nobody remembers owning is not something to leave
   * behind.
   */
  projectRemoving(id: ProjectID): Promise<void>;
}

export interface ProjectServiceDependencies {
  readonly repository: ProjectRepository;
  /** Read-only use only: `probe`, in the project's own directory. */
  readonly git: GitRunning;
  readonly observer: StateObserving;
  readonly sessions: ProjectRemovalObserving;
  /** Where shapes go: an id, a count, a boolean. Absent means silent. */
  readonly log?: Logger;
}

export function createProjectService(deps: ProjectServiceDependencies): ProjectService {
  return new BrainProjectService(deps);
}

/**
 * Which forge a remote URL points at, by host, with no network call.
 *
 * Recognising the host is all we do: whether the integration *works* additionally
 * depends on the user having `gh` or `glab` installed and logged in, and a missing
 * one is silence rather than an error (ADR 0012).
 */
export function forgeForRemote(remoteURL: string): Forge | undefined {
  const host = hostOf(remoteURL);
  if (host === undefined) return undefined;

  if (host === "github.com" || host.endsWith(".github.com")) return "gitHub";
  // Self-hosted GitLab is overwhelmingly `gitlab.<company>` or `gitlab-ee.<...>`,
  // and there is no other way to tell: the URL is all we have, and we are not
  // probing an unknown host to find out.
  if (host.split(".").some((label) => label === "gitlab" || label.startsWith("gitlab")))
    return "gitLab";
  return undefined;
}

/** The host of a remote URL, whether it is scp-like, ssh://, https:// or git://. */
function hostOf(remoteURL: string): string | undefined {
  // `git@github.com:user/repo.git` is not a URL and `new URL` refuses it, which is
  // exactly the form `git clone` hands out by default.
  const scpLike = /^[^@/]+@([^:/]+):/.exec(remoteURL);
  const host = scpLike?.[1];
  if (host !== undefined) return host.toLowerCase();

  try {
    return new URL(remoteURL).hostname.toLowerCase();
  } catch {
    // A path, a typo, or something we have never seen. Not a forge either way.
    return undefined;
  }
}

class BrainProjectService implements ProjectService {
  private readonly deps: ProjectServiceDependencies;
  private readonly log: Logger;
  private known: Project[] = [];

  constructor(deps: ProjectServiceDependencies) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
  }

  get projects(): readonly Project[] {
    return this.known;
  }

  async load(): Promise<void> {
    // Database only. Git detection happens per project, in the background, and a
    // cold network mount must not hold up the first client's snapshot.
    this.known = [...(await this.deps.repository.all())];
  }

  find(id: ProjectID): Project | undefined {
    return this.known.find((project) => project.id === id);
  }

  async addProject(request: {
    readonly directory: AbsolutePath;
    readonly name?: string;
  }): Promise<Project> {
    const existing = this.known.find((project) => project.directory === request.directory);
    if (existing !== undefined) throw new ProjectAlreadyAdded(request.directory);

    const project: Project = {
      id: newProjectID(),
      // `basename("/")` is empty, and a project called "" is unusable; the path
      // itself is a worse name than nothing but at least identifies the thing.
      name: request.name ?? (basename(request.directory) || request.directory),
      directory: request.directory,
      settings: {
        worktreeRoot: { kind: "siblingDirectory" },
        automation: [],
        isForgeEnabled: true,
      },
      accent: "none",
      isExpanded: true,
      addedAt: now(),
    };

    await this.deps.repository.save(project);
    this.known.push(project);
    // Announce before git: the user picked a directory and expects it in the
    // sidebar now, not after a `git remote get-url` on a cold NFS mount.
    await this.deps.observer.projectsChanged(this.known);

    void this.refreshGit(project.id).catch((error: unknown) => {
      this.log.warning("project git refresh failed", {
        project: project.id,
        reason: error instanceof Error ? error.name : "unknown",
      });
    });

    return project;
  }

  async removeProject(id: ProjectID): Promise<void> {
    const project = this.find(id);
    if (project === undefined) throw new UnknownProject(id);

    // Before the row goes: the sessions cascade with it, so this is the last
    // moment anything knows which terminals belonged to them.
    await this.deps.sessions.projectRemoving(id);

    await this.deps.repository.remove(id);
    this.known = this.known.filter((candidate) => candidate.id !== id);
    // Never a directory. A per-session removal plan is the only path that deletes
    // files, and it asks first.
    await this.deps.observer.projectsChanged(this.known);
  }

  async updateSettings(id: ProjectID, settings: ProjectSettings): Promise<void> {
    const project = this.find(id);
    if (project === undefined) throw new UnknownProject(id);

    project.settings = settings;
    await this.deps.repository.save(project);
    await this.deps.observer.projectsChanged(this.known);
  }

  /**
   * Detects the project's git facts and records them.
   *
   * Everything here is `probe`: not being a repository is an answer, not a
   * failure. Always announces at the end, even when nothing changed, so a client
   * knows detection has settled rather than waiting forever for a second update.
   */
  private async refreshGit(id: ProjectID): Promise<void> {
    const project = this.find(id);
    if (project === undefined) return;

    const git = await this.detectGit(project.directory);

    // It may have been removed while git was running; announcing a project that
    // is gone would resurrect it in every mirror.
    if (this.find(id) === undefined) return;

    if (git === undefined) {
      delete project.git;
    } else {
      project.git = git;
    }
    await this.deps.repository.save(project);
    await this.deps.observer.projectsChanged(this.known);

    this.log.debug("project git refreshed", {
      project: id,
      isRepository: git !== undefined,
      hasRemote: git?.remoteURL !== undefined,
      forge: git?.forge ?? "none",
    });
  }

  private async detectGit(directory: AbsolutePath): Promise<GitDescriptor | undefined> {
    const toplevel = await this.deps.git.probe(["rev-parse", "--show-toplevel"], directory);
    if (!toplevel.succeeded) return undefined;

    // The user may have picked a subdirectory of a repository. That is a folder
    // project, not a repository one: `worktree add` from a subdirectory would run
    // against a repository the user did not choose.
    if (!(await sameDirectory(toplevel.standardOutput.trim(), directory))) return undefined;

    const remote = await this.deps.git.probe(["remote", "get-url", "origin"], directory);
    const trimmed = remote.succeeded ? remote.standardOutput.trim() : "";
    const remoteURL = trimmed === "" ? undefined : trimmed;
    const forge = remoteURL === undefined ? undefined : forgeForRemote(remoteURL);
    const defaultBranch = await this.detectDefaultBranch(directory);

    return {
      ...(remoteURL === undefined ? {} : { remoteURL }),
      // Always set for a repository, and load-bearing: a `GitDescriptor` whose
      // three fields are all absent reads back from the database as no descriptor
      // at all, so the project would look like a plain folder.
      defaultBranch,
      ...(forge === undefined ? {} : { forge }),
    };
  }

  /**
   * The branch a new worktree should be cut from, cached so the creation sheet can
   * preselect without shelling out.
   *
   * `origin/HEAD` is the honest answer when it exists; a fresh clone from some
   * hosts has no such ref, and a repository with no remote has none by definition.
   */
  private async detectDefaultBranch(directory: AbsolutePath): Promise<string> {
    const remoteHead = await this.deps.git.probe(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      directory,
    );
    if (remoteHead.succeeded) {
      const value = remoteHead.standardOutput.trim();
      if (value !== "") return value.startsWith("origin/") ? value.slice("origin/".length) : value;
    }

    const head = await this.deps.git.probe(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      directory,
    );
    if (head.succeeded && head.standardOutput.trim() !== "") return head.standardOutput.trim();

    for (const candidate of ["main", "master"]) {
      // oxlint-disable-next-line no-await-in-loop
      const exists = await this.deps.git.probe(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
        directory,
      );
      if (exists.succeeded) return candidate;
    }

    // A repository with no commits and a detached HEAD. "HEAD" is what git itself
    // shows, and it is a start point `worktree add` accepts.
    return "HEAD";
  }
}

/**
 * Whether two paths name the same directory.
 *
 * `realpath` on both sides because macOS reports `/var/…` and `/private/var/…` for
 * the same directory, and git canonicalises while a file dialog does not. A path
 * that cannot be resolved is not the same directory as anything.
 */
async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}
