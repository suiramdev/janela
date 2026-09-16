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
import { Effect, Option } from "effect";

import { ProjectAlreadyAdded, UnknownProject } from "./errors.ts";
import { silentLogger } from "./silent-logger.ts";
import type { StateObserving } from "./state-observing.ts";

export interface ProjectService {
  readonly projects: readonly Project[];

  load(): Promise<void>;

  find(id: ProjectID): Project | undefined;

  addProject(request: {
    readonly directory: AbsolutePath;
    readonly name?: string;
  }): Promise<Project>;

  removeProject(id: ProjectID): Promise<void>;

  updateSettings(id: ProjectID, settings: ProjectSettings): Promise<void>;
}

export interface ProjectRemovalObserving {
  projectRemoving(id: ProjectID): Promise<void>;
}

export interface ProjectServiceDependencies {
  readonly repository: ProjectRepository;
  readonly git: GitRunning;
  readonly observer: StateObserving;
  readonly sessions: ProjectRemovalObserving;
  readonly log?: Logger;
}

const SCP_LIKE_REMOTE = /^[^@/]+@([^:/]+):/;

const GITLAB_LABEL = "gitlab";

const DETACHED_HEAD_START_POINT = "HEAD";

const FALLBACK_DEFAULT_BRANCHES = ["main", "master"];

const parseURL = Option.liftThrowable((value: string) => new URL(value));

export function createProjectService(deps: ProjectServiceDependencies): ProjectService {
  return new BrainProjectService(deps);
}

export function forgeForRemote(remoteURL: string): Forge | undefined {
  const host = hostOf(remoteURL);

  if (host === undefined) return undefined;

  if (host === "github.com" || host.endsWith(".github.com")) return "gitHub";

  if (host.split(".").some((label) => label.startsWith(GITLAB_LABEL))) return "gitLab";

  return undefined;
}

function hostOf(remoteURL: string): string | undefined {
  const scpLikeHost = SCP_LIKE_REMOTE.exec(remoteURL)?.[1];

  if (scpLikeHost !== undefined) return scpLikeHost.toLowerCase();

  return Option.getOrUndefined(
    Option.map(parseURL(remoteURL), (url) => url.hostname.toLowerCase()),
  );
}

function sameDirectory(left: string, right: string): Promise<boolean> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => (await realpath(left)) === (await realpath(right)),
      catch: (cause: unknown) => cause,
    }).pipe(Effect.orElseSucceed(() => false)),
  );
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
    await this.deps.observer.projectsChanged(this.known);

    void this.refreshGit(project.id).catch((cause: unknown) => {
      this.log.warning("project git refresh failed", {
        project: project.id,
        reason: cause instanceof Error ? cause.name : "unknown",
      });
    });

    return project;
  }

  async removeProject(id: ProjectID): Promise<void> {
    const project = this.find(id);

    if (project === undefined) throw new UnknownProject(id);

    await this.deps.sessions.projectRemoving(id);

    await this.deps.repository.remove(id);
    this.known = this.known.filter((candidate) => candidate.id !== id);
    await this.deps.observer.projectsChanged(this.known);
  }

  async updateSettings(id: ProjectID, settings: ProjectSettings): Promise<void> {
    const project = this.find(id);

    if (project === undefined) throw new UnknownProject(id);

    project.settings = settings;
    await this.deps.repository.save(project);
    await this.deps.observer.projectsChanged(this.known);
  }

  private async refreshGit(id: ProjectID): Promise<void> {
    const project = this.find(id);

    if (project === undefined) return;

    const git = await this.detectGit(project.directory);

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

    if (!(await sameDirectory(toplevel.standardOutput.trim(), directory))) return undefined;

    const remote = await this.deps.git.probe(["remote", "get-url", "origin"], directory);
    const trimmed = remote.succeeded ? remote.standardOutput.trim() : "";
    const remoteURL = trimmed === "" ? undefined : trimmed;

    const descriptor: GitDescriptor = { defaultBranch: await this.detectDefaultBranch(directory) };

    if (remoteURL !== undefined) {
      descriptor.remoteURL = remoteURL;

      const forge = forgeForRemote(remoteURL);

      if (forge !== undefined) descriptor.forge = forge;
    }

    return descriptor;
  }

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

    for (const candidate of FALLBACK_DEFAULT_BRANCHES) {
      // oxlint-disable-next-line no-await-in-loop
      const exists = await this.deps.git.probe(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
        directory,
      );

      if (exists.succeeded) return candidate;
    }

    return DETACHED_HEAD_START_POINT;
  }
}
