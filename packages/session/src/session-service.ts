import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  AbsolutePath,
  AutomationEvent,
  Axis,
  Backing,
  LaunchProfileID,
  PaneDestination,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  WorktreeBinding,
} from "@janela/core";
import {
  absolutePath,
  closeTerminal,
  emptyLayout,
  isLive,
  moveTab as moveLayoutTab,
  moveTerminal as moveLayoutTerminal,
  newSessionID,
  newTerminalID,
  now,
  ownsItsDirectory,
  splitPane,
  supportsWorktrees,
  worktreeOf,
} from "@janela/core";
import type { LaunchProfileRepository, SessionRepository } from "@janela/db";
import { PullRequestUnavailable, type ForgeServing } from "@janela/forge";
import type {
  GitWorktree,
  WorktreeIncluding,
  WorktreeRemovalSafety,
  WorktreeServing,
} from "@janela/git";
import type { Logger } from "@janela/support";
import { processRunner, type ProcessRunning } from "@janela/support/process";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { createLiveTerminal } from "@janela/terminal";
import { Effect, Exit, Match } from "effect";

import type { AutomationRunning } from "./automation-runner.ts";
import {
  LayoutTooDeep,
  NotAWorktree,
  PullRequestsNotSupported,
  UnknownLaunchProfile,
  UnknownProject,
  UnknownSession,
  UnknownTerminal,
  WorktreesUnsupported,
} from "./errors.ts";
import type { ProjectRemovalObserving, ProjectService } from "./project-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";
import type { StateObserving } from "./state-observing.ts";
import { resolveTerminalLaunch, type TerminalLaunchInput } from "./terminal-launch.ts";

export interface SessionService {
  readonly sessions: readonly Session[];

  load(): Promise<void>;

  find(id: SessionID): Session | undefined;
  inProject(id: ProjectID): readonly Session[];

  readonly standaloneSessions: readonly Session[];

  createSession(request: SessionCreationRequest): Promise<Session>;

  branchOverview(projectID: ProjectID): Promise<ProjectBranchOverview>;

  moveTab(sessionID: SessionID, from: number, to: number): Promise<void>;

  moveTerminal(
    sessionID: SessionID,
    terminalID: TerminalID,
    destination: PaneDestination,
  ): Promise<void>;

  removalPlan(id: SessionID): Promise<SessionRemovalPlan>;

  removeSession(id: SessionID, plan: SessionRemovalPlan): Promise<void>;

  rename(id: SessionID, name: string): Promise<void>;

  createTerminal(id: SessionID, options?: NewTerminalOptions): Promise<TerminalDescriptor>;

  startTerminal(id: TerminalID): Promise<void>;
  stopTerminal(id: TerminalID): Promise<void>;

  restartTerminal(id: TerminalID): Promise<void>;

  removeTerminal(id: TerminalID): Promise<void>;
}

export interface NewTerminalOptions {
  readonly profileID?: LaunchProfileID;
  readonly title?: string;
  readonly placement?: {
    readonly kind: "split";
    readonly beside: TerminalID;
    readonly axis: Axis;
  };
}

export interface ProjectBranchWorktree {
  readonly directory: AbsolutePath;
  readonly branch?: string;
  readonly isMain: boolean;
}

export interface ProjectBranchOverview {
  readonly branches: readonly string[];
  readonly worktrees: readonly ProjectBranchWorktree[];
}

export type SessionCreationRequest =
  | { readonly kind: "standalone"; readonly directory: AbsolutePath; readonly name?: string }
  | {
      readonly kind: "inProject";
      readonly projectID: ProjectID;
      readonly branch?: string;
      readonly name?: string;
    }
  | {
      readonly kind: "newWorktree";
      readonly projectID: ProjectID;
      readonly branch: string;
      readonly startPoint?: string;
      readonly directory?: AbsolutePath;
      readonly name?: string;
      readonly shareBranch?: boolean;
    }
  | {
      readonly kind: "adoptWorktree";
      readonly projectID: ProjectID;
      readonly directory: AbsolutePath;
      readonly name?: string;
    }
  | { readonly kind: "fromPullRequest"; readonly projectID: ProjectID; readonly number: number };

export interface SessionRemovalPlan {
  readonly liveTerminalCount: number;

  readonly canDeleteDirectory: boolean;

  deletesDirectory: boolean;

  readonly includedPaths: readonly string[];

  readonly runsTeardownAutomation: boolean;

  readonly safety: WorktreeRemovalSafety;
}

export interface SessionServiceDependencies {
  readonly repository: SessionRepository;
  readonly profiles: LaunchProfileRepository;
  readonly projects: Pick<ProjectService, "find">;
  readonly worktrees: WorktreeServing;
  readonly terminals: TerminalRegistry;
  readonly shell: ShellEnvironment;
  readonly observer: StateObserving;
  readonly processes?: ProcessRunning;
  readonly log?: Logger;
  readonly include?: WorktreeIncluding;
  readonly automation?: AutomationRunning;
  readonly createTerminal?: typeof createLiveTerminal;
  readonly forge?: ForgeServing;
}

interface WorktreePlan {
  readonly branch: string;
  readonly startPoint?: string;
  readonly shareBranch?: boolean;
}

interface ResolvedRequest {
  readonly project?: Project;
  readonly name: string;
  readonly directory: AbsolutePath;
  readonly backing: Backing;
  readonly worktreePlan?: WorktreePlan;
  readonly checkoutBranch?: string;
}

type CreateWorktreeRequest = Parameters<WorktreeServing["createWorktree"]>[0];

type MutableBranchWorktree = {
  -readonly [Key in keyof ProjectBranchWorktree]: ProjectBranchWorktree[Key];
};

type MutableResolvedRequest = {
  -readonly [Key in keyof ResolvedRequest]: ResolvedRequest[Key];
};

type MutableWorktreePlan = {
  -readonly [Key in keyof WorktreePlan]: WorktreePlan[Key];
};

type MutableCreateWorktreeRequest = {
  -readonly [Key in keyof CreateWorktreeRequest]: CreateWorktreeRequest[Key];
};

type MutableLaunchInput = {
  -readonly [Key in keyof TerminalLaunchInput]: TerminalLaunchInput[Key];
};

type StandaloneRequest = Extract<SessionCreationRequest, { kind: "standalone" }>;

type InProjectRequest = Extract<SessionCreationRequest, { kind: "inProject" }>;

type NewWorktreeRequest = Extract<SessionCreationRequest, { kind: "newWorktree" }>;

type AdoptWorktreeRequest = Extract<SessionCreationRequest, { kind: "adoptWorktree" }>;

type PullRequestRequest = Extract<SessionCreationRequest, { kind: "fromPullRequest" }>;

const SIBLING_WORKTREE_DIRECTORY = ".worktrees";

const FALLBACK_WORKTREE_SLUG = "worktree";

const AWKWARD_IN_A_PATH = /[^A-Za-z0-9._-]/g;

const REPEATED_SEPARATOR = /-+/g;

const LEADING_SEPARATORS = /^[-.]+/;

const TRAILING_SEPARATORS = /[-.]+$/;

export function createSessionService(
  deps: SessionServiceDependencies,
): SessionService & ProjectRemovalObserving {
  return new BrainSessionService(deps);
}

export function worktreeSlug(name: string): string {
  const replaced = name.replace(AWKWARD_IN_A_PATH, "-").replace(REPEATED_SEPARATOR, "-");
  const trimmed = replaced.replace(LEADING_SEPARATORS, "").replace(TRAILING_SEPARATORS, "");

  return trimmed === "" ? FALLBACK_WORKTREE_SLUG : trimmed;
}

export function defaultWorktreeDirectory(project: Project, name: string): AbsolutePath {
  const root = project.settings.worktreeRoot;
  const slug = worktreeSlug(name);

  return absolutePath(
    root.kind === "custom"
      ? join(root.directory, slug)
      : join(dirname(project.directory), SIBLING_WORKTREE_DIRECTORY, slug),
  );
}

function branchWorktree(entry: GitWorktree, isMain: boolean): ProjectBranchWorktree {
  const reduced: MutableBranchWorktree = { directory: entry.path, isMain };

  if (entry.branch !== undefined) reduced.branch = entry.branch;

  return reduced;
}

function canonicalPath(directory: AbsolutePath): Promise<string> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => realpath(directory),
      catch: (cause: unknown) => cause,
    }).pipe(Effect.orElseSucceed((): string => directory)),
  );
}

class BrainSessionService implements SessionService, ProjectRemovalObserving {
  private readonly deps: SessionServiceDependencies;
  private readonly log: Logger;
  private readonly processes: ProcessRunning;
  private known: Session[] = [];

  constructor(deps: SessionServiceDependencies) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
    this.processes = deps.processes ?? processRunner();
  }

  get sessions(): readonly Session[] {
    return this.known;
  }

  get standaloneSessions(): readonly Session[] {
    return this.known.filter((session) => session.projectID === undefined);
  }

  async load(): Promise<void> {
    this.known = [...(await this.deps.repository.all())];
  }

  find(id: SessionID): Session | undefined {
    return this.known.find((session) => session.id === id);
  }

  inProject(id: ProjectID): readonly Session[] {
    return this.known.filter((session) => session.projectID === id);
  }

  async createSession(request: SessionCreationRequest): Promise<Session> {
    const resolved = await this.resolve(request);

    if (resolved.checkoutBranch !== undefined && resolved.project !== undefined) {
      await this.deps.worktrees.checkoutBranch(resolved.project.directory, resolved.checkoutBranch);
    }

    const created = now();
    const session: Session = {
      id: newSessionID(),
      name: resolved.name,
      directory: resolved.directory,
      backing: resolved.backing,
      terminals: [],
      layout: emptyLayout,
      accent: "none",
      createdAt: created,
      lastActiveAt: created,
      isPinned: false,
    };

    if (resolved.project !== undefined) session.projectID = resolved.project.id;

    await this.deps.repository.save(session);
    this.known.push(session);
    await this.publish();

    if (resolved.worktreePlan !== undefined && resolved.project !== undefined) {
      await this.addWorktree(session, resolved.project, resolved.worktreePlan);
    }

    if (worktreeOf(session) !== undefined && resolved.project !== undefined) {
      await this.copyIncludedPaths(session, resolved.project);
    }

    if (resolved.project !== undefined) {
      if (resolved.worktreePlan !== undefined) {
        await this.runAutomation("worktreeCreated", resolved.project, session);
      }

      await this.runAutomation("sessionStart", resolved.project, session);
    }

    await this.addFirstTerminal(session, resolved.project);

    this.log.info("session created", {
      session: session.id,
      kind: request.kind,
      backing: session.backing.kind,
    });

    return session;
  }

  async branchOverview(projectID: ProjectID): Promise<ProjectBranchOverview> {
    const project = this.requireProject(projectID);

    if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

    const [branches, listed] = await Promise.all([
      this.deps.worktrees.branches(project.directory),
      this.deps.worktrees.worktrees(project.directory),
    ]);

    return {
      branches,
      worktrees: listed
        .map((entry, index) => ({ entry, isMain: index === 0 }))
        .filter(({ entry }) => !entry.isBare)
        .map(({ entry, isMain }) => branchWorktree(entry, isMain)),
    };
  }

  async moveTab(sessionID: SessionID, from: number, to: number): Promise<void> {
    const session = this.find(sessionID);

    if (session === undefined) throw new UnknownSession(sessionID);

    const layout = moveLayoutTab(session.layout, from, to);

    if (layout === session.layout) return;

    session.layout = layout;
    await this.deps.repository.save(session);
    await this.publish();
  }

  async moveTerminal(
    sessionID: SessionID,
    terminalID: TerminalID,
    destination: PaneDestination,
  ): Promise<void> {
    const session = this.find(sessionID);

    if (session === undefined) throw new UnknownSession(sessionID);

    const holds = (id: TerminalID): boolean =>
      session.terminals.some((terminal) => terminal.id === id);

    if (!holds(terminalID)) throw new UnknownTerminal(terminalID);

    if (destination.kind === "beside" && !holds(destination.terminal)) {
      throw new UnknownTerminal(destination.terminal);
    }

    const layout = moveLayoutTerminal(session.layout, terminalID, destination);

    if (layout === session.layout) return;

    session.layout = layout;
    await this.deps.repository.save(session);
    await this.publish();
  }

  async removalPlan(id: SessionID): Promise<SessionRemovalPlan> {
    const session = this.find(id);

    if (session === undefined) throw new UnknownSession(id);

    const live = this.deps.terminals
      .inSession(id)
      .filter((terminal) => isLive(terminal.state)).length;
    const binding = worktreeOf(session);
    const project = this.projectOf(session);

    return {
      liveTerminalCount: live,
      canDeleteDirectory: ownsItsDirectory(session),
      deletesDirectory: false,
      includedPaths: binding?.includedPaths ?? [],
      runsTeardownAutomation:
        project?.settings.automation.some(
          (command) => command.event === "sessionTeardown" && command.isEnabled,
        ) ?? false,
      safety: await this.safetyFor(session, project, live),
    };
  }

  async removeSession(id: SessionID, plan: SessionRemovalPlan): Promise<void> {
    const session = this.find(id);

    if (session === undefined) throw new UnknownSession(id);

    const project = this.projectOf(session);

    if (plan.runsTeardownAutomation && project !== undefined) {
      await this.runAutomation("sessionTeardown", project, session);
    }

    await this.stopTerminalsOf(id);

    if (plan.deletesDirectory && plan.canDeleteDirectory && project !== undefined) {
      await this.deps.worktrees.removeWorktree({
        directory: session.directory,
        repository: project.directory,
        force: plan.safety.hasUncommittedChanges || plan.safety.hasUntrackedFiles,
      });
    }

    await this.forgetSession(id);
    this.log.info("session removed", {
      session: id,
      deletedDirectory: plan.deletesDirectory && plan.canDeleteDirectory,
    });
  }

  async projectRemoving(id: ProjectID): Promise<void> {
    const going = this.inProject(id);

    for (const session of going) {
      // oxlint-disable-next-line no-await-in-loop
      await this.stopTerminalsOf(session.id);
    }

    this.known = this.known.filter((session) => session.projectID !== id);
    await this.publish();
    this.log.info("project sessions dropped", { project: id, sessions: going.length });
  }

  async rename(id: SessionID, name: string): Promise<void> {
    const session = this.find(id);

    if (session === undefined) throw new UnknownSession(id);

    session.name = name;
    await this.deps.repository.save(session);
    await this.publish();
  }

  async createTerminal(
    id: SessionID,
    options: NewTerminalOptions = {},
  ): Promise<TerminalDescriptor> {
    const session = this.find(id);

    if (session === undefined) throw new UnknownSession(id);

    const profileID = options.profileID;
    const profile = profileID === undefined ? undefined : await this.deps.profiles.find(profileID);

    if (profileID !== undefined && profile === undefined) throw new UnknownLaunchProfile(profileID);

    const descriptor: TerminalDescriptor = {
      id: newTerminalID(),
      title: options.title ?? profile?.name ?? "Shell",
      startsAutomatically: true,
      role: { kind: "user" },
      createdAt: now(),
    };

    if (profile !== undefined) descriptor.profileID = profile.id;

    const placement = options.placement;

    if (placement === undefined) {
      this.appendTerminalTab(session, descriptor, { focus: true });
    } else {
      if (!session.terminals.some((terminal) => terminal.id === placement.beside)) {
        throw new UnknownTerminal(placement.beside);
      }

      const layout = splitPane(session.layout, placement.beside, descriptor.id, placement.axis);

      if (layout === session.layout) throw new LayoutTooDeep(session.id);

      session.terminals = [...session.terminals, descriptor];
      session.layout = layout;
    }

    await this.deps.repository.save(session);
    await this.publish();

    return descriptor;
  }

  async startTerminal(id: TerminalID): Promise<void> {
    const located = this.locate(id);

    if (located === undefined) throw new UnknownTerminal(id);

    const { session, descriptor } = located;

    let live = this.deps.terminals.get(id);

    if (live === undefined) {
      live = await this.liveTerminalFor(session, descriptor);
      this.deps.terminals.register(live);
    }

    await live.start();
    await this.deps.repository.touch(session.id);
    session.lastActiveAt = now();
    await this.publish();
  }

  async stopTerminal(id: TerminalID): Promise<void> {
    await this.deps.terminals.get(id)?.stop();
  }

  async restartTerminal(id: TerminalID): Promise<void> {
    const located = this.locate(id);

    if (located === undefined) throw new UnknownTerminal(id);

    const live = this.deps.terminals.get(id);

    if (live === undefined) {
      await this.startTerminal(id);

      return;
    }

    await live.restart();
    await this.deps.repository.touch(located.session.id);
    located.session.lastActiveAt = now();
    await this.publish();
  }

  async removeTerminal(id: TerminalID): Promise<void> {
    const located = this.locate(id);

    if (located === undefined) throw new UnknownTerminal(id);

    const { session } = located;

    const live = this.deps.terminals.get(id);

    if (live !== undefined) {
      await live.stop();
      this.deps.terminals.remove(id);
    }

    session.terminals = session.terminals.filter((terminal) => terminal.id !== id);
    session.layout = closeTerminal(session.layout, id);

    if (session.layout.tabs.length === 0) {
      await this.addFirstTerminal(session, this.projectOf(session));

      return;
    }

    await this.deps.repository.save(session);
    await this.publish();
  }

  private async publish(): Promise<void> {
    await this.deps.observer.sessionsChanged(this.known);
  }

  private async stopTerminalsOf(id: SessionID): Promise<void> {
    for (const terminal of this.deps.terminals.inSession(id)) {
      // oxlint-disable-next-line no-await-in-loop
      await terminal.stop();
      this.deps.terminals.remove(terminal.id);
    }
  }

  private async forgetSession(id: SessionID): Promise<void> {
    this.known = this.known.filter((candidate) => candidate.id !== id);
    await this.deps.repository.remove(id);
    await this.publish();
  }

  private projectOf(session: Session): Project | undefined {
    return session.projectID === undefined ? undefined : this.deps.projects.find(session.projectID);
  }

  private requireProject(id: ProjectID): Project {
    const project = this.deps.projects.find(id);

    if (project === undefined) throw new UnknownProject(id);

    return project;
  }

  private locate(id: TerminalID): { session: Session; descriptor: TerminalDescriptor } | undefined {
    for (const session of this.known) {
      const descriptor = session.terminals.find((terminal) => terminal.id === id);

      if (descriptor !== undefined) return { session, descriptor };
    }

    return undefined;
  }

  private resolve(request: SessionCreationRequest): Promise<ResolvedRequest> {
    return Promise.resolve(
      Match.value(request).pipe(
        Match.discriminatorsExhaustive("kind")({
          standalone: (standalone) => this.resolveStandalone(standalone),
          inProject: (inProject) => this.resolveInProject(inProject),
          newWorktree: (newWorktree) => this.resolveNewWorktree(newWorktree),
          adoptWorktree: (adoptWorktree) => this.resolveAdoptWorktree(adoptWorktree),
          fromPullRequest: (pullRequest) => this.resolveFromPullRequest(pullRequest),
        }),
      ),
    );
  }

  private resolveStandalone(request: StandaloneRequest): ResolvedRequest {
    return {
      name: request.name ?? basename(request.directory),
      directory: request.directory,
      backing: { kind: "folder" },
    };
  }

  private resolveInProject(request: InProjectRequest): ResolvedRequest {
    const project = this.requireProject(request.projectID);

    if (request.branch !== undefined && !supportsWorktrees(project)) {
      throw new WorktreesUnsupported(project.id);
    }

    const resolved: MutableResolvedRequest = {
      project,
      name: request.name ?? request.branch ?? project.name,
      directory: project.directory,
      backing: { kind: "projectDirectory" },
    };

    if (request.branch !== undefined) resolved.checkoutBranch = request.branch;

    return resolved;
  }

  private resolveNewWorktree(request: NewWorktreeRequest): ResolvedRequest {
    const project = this.requireProject(request.projectID);

    if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

    const name = request.name ?? request.branch;
    const directory = request.directory ?? defaultWorktreeDirectory(project, name);

    const worktreePlan: MutableWorktreePlan = { branch: request.branch };

    if (request.startPoint !== undefined) worktreePlan.startPoint = request.startPoint;

    if (request.shareBranch === true) worktreePlan.shareBranch = true;

    return {
      project,
      name,
      directory,
      backing: {
        kind: "worktree",
        binding: {
          branch: request.branch,
          path: directory,
          ownership: "managed",
          includedPaths: [],
        },
      },
      worktreePlan,
    };
  }

  private async resolveAdoptWorktree(request: AdoptWorktreeRequest): Promise<ResolvedRequest> {
    const project = this.requireProject(request.projectID);

    if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

    const listed = await this.findWorktree(project.directory, request.directory);

    if (listed === undefined) throw new NotAWorktree(request.directory);

    const binding: WorktreeBinding = {
      path: listed.path,
      ownership: "adopted",
      includedPaths: [],
    };

    if (listed.branch !== undefined) binding.branch = listed.branch;

    if (listed.head !== undefined) binding.baseCommit = listed.head;

    return {
      project,
      name: request.name ?? basename(listed.path),
      directory: listed.path,
      backing: { kind: "worktree", binding },
    };
  }

  private async resolveFromPullRequest(request: PullRequestRequest): Promise<ResolvedRequest> {
    const project = this.requireProject(request.projectID);

    if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

    if (this.deps.forge === undefined) throw new PullRequestsNotSupported();

    const branch = await this.deps.forge.pullRequestBranch({ project, number: request.number });

    if (branch === undefined) throw new PullRequestUnavailable(request.number);

    return this.resolveNewWorktree({
      kind: "newWorktree",
      projectID: project.id,
      branch,
      startPoint: `origin/${branch}`,
    });
  }

  private async findWorktree(
    repository: AbsolutePath,
    directory: AbsolutePath,
  ): Promise<GitWorktree | undefined> {
    const listed = await this.deps.worktrees.worktrees(repository);
    const canonical = await canonicalPath(directory);

    return listed.find((entry) => entry.path === directory || entry.path === canonical);
  }

  private addWorktree(session: Session, project: Project, plan: WorktreePlan): Promise<void> {
    const request: MutableCreateWorktreeRequest = {
      repository: project.directory,
      directory: session.directory,
      branch: plan.branch,
    };

    if (plan.startPoint !== undefined) request.startPoint = plan.startPoint;

    if (plan.shareBranch === true) request.force = true;

    return Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(Effect.succeed(session.id), (id, exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.promise(() => this.forgetSession(id)),
        ).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              try: () => this.deps.worktrees.createWorktree(request),
              catch: (cause: unknown) => cause,
            }),
          ),
          Effect.flatMap((created) =>
            Effect.promise(() => this.bindWorktree(session, created, plan.branch)),
          ),
        ),
      ),
    );
  }

  private async bindWorktree(
    session: Session,
    created: GitWorktree,
    branch: string,
  ): Promise<void> {
    const binding: WorktreeBinding = {
      branch: created.branch ?? branch,
      path: created.path,
      ownership: "managed",
      includedPaths: [],
    };

    if (created.head !== undefined) binding.baseCommit = created.head;

    session.directory = created.path;
    session.backing = { kind: "worktree", binding };
    await this.deps.repository.save(session);
    await this.publish();
  }

  private copyIncludedPaths(session: Session, project: Project): Promise<void> {
    const include = this.deps.include;

    if (include === undefined) return Promise.resolve();

    return Effect.runPromise(
      Effect.tryPromise({
        try: () => this.copyAndRecord(include, session, project),
        catch: (cause: unknown) => cause,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            this.log.warning("worktreeinclude copy failed", { session: session.id });
          }),
        ),
      ),
    );
  }

  private async copyAndRecord(
    include: WorktreeIncluding,
    session: Session,
    project: Project,
  ): Promise<void> {
    const paths = await include.resolve(project.directory);

    if (paths.length === 0) return;

    const report = await include.copy({
      repository: project.directory,
      worktree: session.directory,
      paths,
    });

    const binding = worktreeOf(session);

    if (binding === undefined) return;

    binding.includedPaths = report.copied;
    await this.deps.repository.save(session);
    await this.publish();
  }

  private async runAutomation(
    event: AutomationEvent,
    project: Project,
    session: Session,
  ): Promise<void> {
    const automation = this.deps.automation;

    if (automation === undefined) return;

    const ran = await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          automation.run({
            event,
            project,
            session,
            attach: (descriptor) => this.attachAutomationTerminal(session, descriptor),
          }),
        catch: (cause: unknown) => cause,
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
    );

    if (!ran) {
      this.log.warning("automation failed", { session: session.id, event });

      return;
    }

    await this.publish();
  }

  private async addFirstTerminal(session: Session, project: Project | undefined): Promise<void> {
    const profileID = project?.settings.defaultProfileID;
    const profile = profileID === undefined ? undefined : await this.deps.profiles.find(profileID);

    const descriptor: TerminalDescriptor = {
      id: newTerminalID(),
      title: profile?.name ?? "Shell",
      startsAutomatically: true,
      role: { kind: "user" },
      createdAt: now(),
    };

    if (profile !== undefined) descriptor.profileID = profile.id;

    this.appendTerminalTab(session, descriptor, { focus: true });
    await this.deps.repository.save(session);
    await this.publish();
  }

  private async attachAutomationTerminal(
    session: Session,
    descriptor: TerminalDescriptor,
  ): Promise<void> {
    this.appendTerminalTab(session, descriptor, { focus: false });
    await this.deps.repository.save(session);
    await this.publish();
  }

  private appendTerminalTab(
    session: Session,
    descriptor: TerminalDescriptor,
    options: { readonly focus: boolean },
  ): void {
    session.terminals = [...session.terminals, descriptor];
    session.layout = {
      tabs: [
        ...session.layout.tabs,
        { root: { kind: "terminal", id: descriptor.id }, focusedTerminalID: descriptor.id },
      ],
      focusedTabIndex: options.focus ? session.layout.tabs.length : session.layout.focusedTabIndex,
    };
  }

  private async liveTerminalFor(
    session: Session,
    descriptor: TerminalDescriptor,
  ): Promise<LiveTerminal> {
    const profile =
      descriptor.profileID === undefined
        ? undefined
        : await this.deps.profiles.find(descriptor.profileID);
    const project = this.projectOf(session);

    const input: MutableLaunchInput = {
      session,
      terminal: descriptor,
      shell: this.deps.shell,
      processes: this.processes,
    };

    if (project !== undefined) input.project = project;

    if (profile !== undefined) input.profile = profile;

    const launch = await resolveTerminalLaunch(input);
    const create = this.deps.createTerminal ?? createLiveTerminal;

    return create({ descriptor, sessionID: session.id, launch, log: this.log });
  }

  private async safetyFor(
    session: Session,
    project: Project | undefined,
    live: number,
  ): Promise<WorktreeRemovalSafety> {
    const binding = worktreeOf(session);

    if (binding !== undefined && project !== undefined) {
      const listed = await this.findWorktree(project.directory, session.directory);

      if (listed !== undefined) {
        return {
          ...(await this.deps.worktrees.removalSafety(listed)),
          hasRunningSessions: live > 0,
        };
      }
    }

    return {
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      hasUnpushedCommits: false,
      isLocked: false,
      hasRunningSessions: live > 0,
    };
  }
}
