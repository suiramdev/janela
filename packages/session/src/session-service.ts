import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  AbsolutePath,
  Backing,
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
  emptyLayout,
  isLive,
  newSessionID,
  newTerminalID,
  now,
  ownsItsDirectory,
  singleTerminalLayout,
  supportsWorktrees,
  worktreeOf,
} from "@janela/core";
import type { LaunchProfileRepository, SessionRepository } from "@janela/db";
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

import type { AutomationRunning } from "./automation-runner.ts";
import {
  NotAWorktree,
  PullRequestsNotSupported,
  UnknownProject,
  UnknownSession,
  UnknownTerminal,
  WorktreesUnsupported,
} from "./errors.ts";
import type { ProjectRemovalObserving, ProjectService } from "./project-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { silentLogger } from "./silent-logger.ts";
import type { StateObserving } from "./state-observing.ts";
import { resolveTerminalLaunch } from "./terminal-launch.ts";

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

export interface SessionServiceDependencies {
  readonly repository: SessionRepository;
  readonly profiles: LaunchProfileRepository;
  /** Only `find` is used: the session side never mutates a project. */
  readonly projects: Pick<ProjectService, "find">;
  readonly worktrees: WorktreeServing;
  readonly terminals: TerminalRegistry;
  /** Captured once at startup; every terminal is launched from it. */
  readonly shell: ShellEnvironment;
  readonly observer: StateObserving;
  /** Resolves a profile's executable on the captured `PATH`. */
  readonly processes?: ProcessRunning;
  /** Where shapes go: an id, a count, an event name. Absent means silent. */
  readonly log?: Logger;
  /**
   * `.worktreeinclude` copying. Absent means the step is skipped, which is what a
   * repository with no such file amounts to anyway.
   */
  readonly include?: WorktreeIncluding;
  /**
   * Project automation. Absent means no automation runs — a project with no
   * enabled commands is the same thing from the user's side.
   */
  readonly automation?: AutomationRunning;
  /** The terminal-creation seam. Production passes nothing. */
  readonly createTerminal?: typeof createLiveTerminal;
}

export function createSessionService(
  deps: SessionServiceDependencies,
): SessionService & ProjectRemovalObserving {
  return new BrainSessionService(deps);
}

/**
 * A branch name as a directory name.
 *
 * Case is preserved: branch names are case-sensitive, and the user is going to
 * read this path in a shell prompt and in build output. Only characters that make
 * a path awkward are replaced.
 */
export function worktreeSlug(branch: string): string {
  const replaced = branch.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  const trimmed = replaced.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  // A branch of only separators (`///`) would otherwise produce "", and a
  // worktree at the parent directory itself.
  return trimmed === "" ? "worktree" : trimmed;
}

/** Where a project's worktree for `branch` goes when the caller did not choose. */
export function defaultWorktreeDirectory(project: Project, branch: string): AbsolutePath {
  const root = project.settings.worktreeRoot;
  const slug = worktreeSlug(branch);
  return absolutePath(
    root.kind === "custom"
      ? join(root.directory, slug)
      : // Beside the repository rather than under it: a worktree inside the
        // repository is a directory git has to be told to ignore, forever.
        join(dirname(project.directory), ".worktrees", slug),
  );
}

/** A creation request, reduced to the record we are about to write. */
interface ResolvedRequest {
  readonly project?: Project;
  readonly name: string;
  readonly directory: AbsolutePath;
  readonly backing: Backing;
  /** Set only when a worktree still has to be created. */
  readonly worktreePlan?: { readonly branch: string; readonly startPoint?: string };
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
    // Database only, and nothing is started: a restored session's terminals are
    // idle by construction, because the registry is empty until `startTerminal`.
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

    const created = now();
    const session: Session = {
      id: newSessionID(),
      ...(resolved.project === undefined ? {} : { projectID: resolved.project.id }),
      name: resolved.name,
      directory: resolved.directory,
      backing: resolved.backing,
      // No terminals and an empty layout, in that order of importance: the
      // database refuses a layout naming a terminal that does not exist yet.
      terminals: [],
      layout: emptyLayout,
      accent: "none",
      createdAt: created,
      lastActiveAt: created,
      isPinned: false,
    };

    await this.deps.repository.save(session);
    this.known.push(session);
    // Visible and selectable from here. Everything below can take seconds, and a
    // user watching an empty sidebar would reasonably conclude nothing happened.
    await this.publish();

    if (resolved.worktreePlan !== undefined && resolved.project !== undefined) {
      await this.addWorktree(session, resolved.project, resolved.worktreePlan);
    }

    // Before automation, always: a `worktreeCreated` command that runs before the
    // copy finds no `.env` (ADR 0013).
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
      // The client sets this when the user ticks the box. Defaulting to false is
      // the whole safety story: a plan that deletes by default is a bug that
      // deletes by default.
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
      // First, and blocking: this is what the timeout in `AutomationCommand`
      // exists for. A failure is logged and removal continues — refusing to
      // remove a session because a cleanup script exited 1 traps the user.
      await this.runAutomation("sessionTeardown", project, session);
    }

    for (const terminal of this.deps.terminals.inSession(id)) {
      // oxlint-disable-next-line no-await-in-loop
      await terminal.stop();
      this.deps.terminals.remove(terminal.id);
    }

    // `canDeleteDirectory` is the guard, not the client's tick: an adopted
    // worktree or a project checkout is never ours to delete, whatever a plan
    // that reached us says.
    if (plan.deletesDirectory && plan.canDeleteDirectory && project !== undefined) {
      await this.deps.worktrees.removeWorktree({
        directory: session.directory,
        repository: project.directory,
        // Uncommitted or untracked work is exactly what the user was shown and
        // accepted; without `--force` git refuses and the tick did nothing.
        force: plan.safety.hasUncommittedChanges || plan.safety.hasUntrackedFiles,
      });
    }

    await this.deps.repository.remove(id);
    this.known = this.known.filter((candidate) => candidate.id !== id);
    await this.publish();
    this.log.info("session removed", {
      session: id,
      deletedDirectory: plan.deletesDirectory && plan.canDeleteDirectory,
    });
  }

  /**
   * The project is going. Stop its terminals and forget its sessions.
   *
   * No `repository.remove` per session: the rows cascade with the project, and
   * deleting them twice would be two round trips to say the same thing.
   */
  async projectRemoving(id: ProjectID): Promise<void> {
    const going = this.inProject(id);
    for (const session of going) {
      for (const terminal of this.deps.terminals.inSession(session.id)) {
        // oxlint-disable-next-line no-await-in-loop
        await terminal.stop();
        this.deps.terminals.remove(terminal.id);
      }
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

  async startTerminal(id: TerminalID): Promise<void> {
    const located = this.locate(id);
    if (located === undefined) throw new UnknownTerminal(id);
    const { session, descriptor } = located;

    let live = this.deps.terminals.get(id);
    if (live === undefined) {
      live = await this.createTerminal(session, descriptor);
      this.deps.terminals.register(live);
    }

    // Idempotent in `LiveTerminal`, so a second click is not a second process.
    await live.start();
    await this.deps.repository.touch(session.id);
    session.lastActiveAt = now();
    await this.publish();
  }

  async stopTerminal(id: TerminalID): Promise<void> {
    // An unknown id is a no-op: the second click on "stop" must not be an error,
    // and a terminal that already exited is not registered.
    await this.deps.terminals.get(id)?.stop();
  }

  private async publish(): Promise<void> {
    // The whole list, every time. `StateUpdate` merges by id and cannot express a
    // deletion, so a delta would leave removed sessions in every mirror; the
    // brain's list is the truth and this is how it says so.
    await this.deps.observer.sessionsChanged(this.known);
  }

  private projectOf(session: Session): Project | undefined {
    return session.projectID === undefined ? undefined : this.deps.projects.find(session.projectID);
  }

  private requireProject(id: ProjectID): Project {
    const project = this.deps.projects.find(id);
    if (project === undefined) throw new UnknownProject(id);
    return project;
  }

  /** The session and descriptor a terminal id belongs to. */
  private locate(id: TerminalID): { session: Session; descriptor: TerminalDescriptor } | undefined {
    for (const session of this.known) {
      const descriptor = session.terminals.find((terminal) => terminal.id === id);
      if (descriptor !== undefined) return { session, descriptor };
    }
    return undefined;
  }

  private async resolve(request: SessionCreationRequest): Promise<ResolvedRequest> {
    switch (request.kind) {
      case "standalone": {
        return {
          name: request.name ?? basename(request.directory),
          directory: request.directory,
          backing: { kind: "folder" },
        };
      }

      case "inProject": {
        const project = this.requireProject(request.projectID);
        return {
          project,
          name: request.name ?? project.name,
          directory: project.directory,
          backing: { kind: "projectDirectory" },
        };
      }

      case "newWorktree": {
        const project = this.requireProject(request.projectID);
        if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

        const directory = request.directory ?? defaultWorktreeDirectory(project, request.branch);
        return {
          project,
          name: request.name ?? request.branch,
          directory,
          backing: {
            kind: "worktree",
            binding: {
              branch: request.branch,
              // Equal to `directory` because the database refuses anything else,
              // and re-pointed to git's own path once the worktree exists.
              path: directory,
              ownership: "managed",
              includedPaths: [],
            },
          },
          worktreePlan: {
            branch: request.branch,
            ...(request.startPoint === undefined ? {} : { startPoint: request.startPoint }),
          },
        };
      }

      case "adoptWorktree": {
        const project = this.requireProject(request.projectID);
        if (!supportsWorktrees(project)) throw new WorktreesUnsupported(project.id);

        const listed = await this.findWorktree(project.directory, request.directory);
        if (listed === undefined) throw new NotAWorktree(request.directory);

        return {
          project,
          // git's canonical path, not the one the dialog produced: on macOS those
          // differ (`/var` against `/private/var`) and the session compares equal
          // to neither if we keep the wrong one.
          name: request.name ?? basename(listed.path),
          directory: listed.path,
          backing: {
            kind: "worktree",
            binding: {
              ...(listed.branch === undefined ? {} : { branch: listed.branch }),
              ...(listed.head === undefined ? {} : { baseCommit: listed.head }),
              path: listed.path,
              // Adopted, and therefore never deletable by us. It existed before
              // Janela and we do not get to destroy it on a hunch.
              ownership: "adopted",
              includedPaths: [],
            },
          },
        };
      }

      case "fromPullRequest": {
        // Before anything is written, so there is nothing to roll back. The forge
        // integration replaces this branch with a head-branch lookup feeding the
        // `newWorktree` path.
        throw new PullRequestsNotSupported();
      }
    }
  }

  /** The listed worktree at `directory`, matched on git's canonical path too. */
  private async findWorktree(
    repository: AbsolutePath,
    directory: AbsolutePath,
  ): Promise<GitWorktree | undefined> {
    const listed = await this.deps.worktrees.worktrees(repository);
    const canonical = await canonicalPath(directory);
    return listed.find((entry) => entry.path === directory || entry.path === canonical);
  }

  /**
   * Creates the worktree the session already promises.
   *
   * Persist-first means a crash between the record and the directory leaves a
   * session pointing at nothing; a failure we *see* rolls the record back, so the
   * user is not left with a session they cannot open and did not ask for.
   */
  private async addWorktree(
    session: Session,
    project: Project,
    plan: { readonly branch: string; readonly startPoint?: string },
  ): Promise<void> {
    let created;
    try {
      created = await this.deps.worktrees.createWorktree({
        repository: project.directory,
        directory: session.directory,
        branch: plan.branch,
        ...(plan.startPoint === undefined ? {} : { startPoint: plan.startPoint }),
      });
    } catch (error) {
      this.known = this.known.filter((candidate) => candidate.id !== session.id);
      await this.deps.repository.remove(session.id);
      await this.publish();
      // The `GitFailure` is user-facing and says which git subcommand refused,
      // which is more useful than anything we could add.
      throw error;
    }

    const binding: WorktreeBinding = {
      branch: created.branch ?? plan.branch,
      ...(created.head === undefined ? {} : { baseCommit: created.head }),
      path: created.path,
      ownership: "managed",
      includedPaths: [],
    };
    session.directory = created.path;
    session.backing = { kind: "worktree", binding };
    await this.deps.repository.save(session);
    await this.publish();
  }

  /**
   * `.worktreeinclude`, before any automation.
   *
   * A copy failure is logged and creation continues: an `.env` that did not arrive
   * costs the user a copy they can make themselves, and refusing the session over
   * it costs them the terminal (ADR 0013).
   */
  private async copyIncludedPaths(session: Session, project: Project): Promise<void> {
    const include = this.deps.include;
    if (include === undefined) return;

    try {
      const paths = await include.resolve(project.directory);
      if (paths.length === 0) return;

      const report = await include.copy({
        repository: project.directory,
        worktree: session.directory,
        paths,
      });

      const binding = worktreeOf(session);
      if (binding === undefined) return;
      // Recorded at creation rather than recomputed at deletion, so the removal
      // dialog can name the 400 MB `node_modules` it is about to take with it.
      binding.includedPaths = report.copied;
      await this.deps.repository.save(session);
      await this.publish();
    } catch {
      this.log.warning("worktreeinclude copy failed", { session: session.id });
    }
  }

  private async runAutomation(
    event: "worktreeCreated" | "sessionStart" | "sessionTeardown",
    project: Project,
    session: Session,
  ): Promise<void> {
    const automation = this.deps.automation;
    if (automation === undefined) return;

    try {
      await automation.run({ event, project, session });
    } catch {
      // Visible and non-fatal, by product rule: the command's own terminal shows
      // what happened, and the session is still usable.
      this.log.warning("automation failed", { session: session.id, event });
      return;
    }
    await this.publish();
  }

  /**
   * The user's first terminal: configured, not started.
   *
   * Laziness is a feature — a configured terminal costs nothing until something
   * asks for it — and `startsAutomatically` is what tells the opening client to
   * ask.
   */
  private async addFirstTerminal(session: Session, project: Project | undefined): Promise<void> {
    const profileID = project?.settings.defaultProfileID;
    const profile = profileID === undefined ? undefined : await this.deps.profiles.find(profileID);

    const descriptor: TerminalDescriptor = {
      id: newTerminalID(),
      title: profile?.name ?? "Shell",
      // Only when the profile still exists: the column is a foreign key, and a
      // terminal with no profile falls back to the login shell.
      ...(profile === undefined ? {} : { profileID: profile.id }),
      startsAutomatically: true,
      role: { kind: "user" },
      createdAt: now(),
    };

    session.terminals = [descriptor];
    session.layout = singleTerminalLayout(descriptor.id);
    await this.deps.repository.save(session);
    await this.publish();
  }

  private async createTerminal(
    session: Session,
    descriptor: TerminalDescriptor,
  ): Promise<LiveTerminal> {
    const profile =
      descriptor.profileID === undefined
        ? undefined
        : await this.deps.profiles.find(descriptor.profileID);
    const project = this.projectOf(session);

    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor,
      ...(project === undefined ? {} : { project }),
      ...(profile === undefined ? {} : { profile }),
      shell: this.deps.shell,
      processes: this.processes,
    });

    const create = this.deps.createTerminal ?? createLiveTerminal;
    return create({
      descriptor,
      sessionID: session.id,
      launch,
      ...(this.deps.log === undefined ? {} : { log: this.deps.log }),
    });
  }

  /**
   * Whether deleting this session's directory would lose work.
   *
   * `hasRunningSessions` is ours to answer and only ours: git cannot know what is
   * live, so `WorktreeServing` always reports false and we overwrite it.
   */
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

    // Not a worktree, or git has lost it. Nothing git-shaped is at risk, and the
    // only honest flag left is the one we own.
    return {
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      hasUnpushedCommits: false,
      isLocked: false,
      hasRunningSessions: live > 0,
    };
  }
}

/** `realpath`, or the path itself when it does not resolve. */
async function canonicalPath(directory: AbsolutePath): Promise<string> {
  try {
    return await realpath(directory);
  } catch {
    return directory;
  }
}
