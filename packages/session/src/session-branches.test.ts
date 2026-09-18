import { describe, expect, test } from "bun:test";

import type { AbsolutePath, Project } from "@janela/core";
import { newProjectID, now } from "@janela/core";
import type { TemporaryDatabase } from "@janela/db";
import { temporaryDatabase } from "@janela/db";
import { GitFailure, gitRunner, worktreeService, type WorktreeServing } from "@janela/git";
import { createTerminalRegistry } from "@janela/terminal";
import { gitFixture, temporaryDirectory } from "@janela/test-support";

import { UnknownProject, WorktreesUnsupported } from "./errors.ts";
import { createProjectService } from "./project-service.ts";
import { createSessionService, type SessionService } from "./session-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import {
  eventLog,
  fakeCreateTerminal,
  failingGit,
  recordingLogger,
  recordingObserver,
  scriptedProcesses,
} from "./test-fakes.ts";

interface World extends AsyncDisposable {
  readonly sessions: SessionService;
  readonly database: TemporaryDatabase;
  readonly service: WorktreeServing;
  readonly project: Project;
  readonly folder: Project;
  readonly repository: AbsolutePath;
  readonly scratch: (...components: string[]) => AbsolutePath;
  readonly git: (...args: string[]) => Promise<string>;
  readonly currentBranch: () => Promise<string>;
}

const shell: ShellEnvironment = {
  loginShell: "/bin/zsh",
  resolved: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-zsh"],
};

const rejection = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error("the call resolved instead of rejecting");
    },
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

async function setup(label: string): Promise<World> {
  const fixture = await gitFixture(label);
  const scratch = await temporaryDirectory(`${label}-worktrees`);
  const database = await temporaryDatabase();
  const repository = fixture.path as AbsolutePath;

  const project: Project = {
    id: newProjectID(),
    name: "fixture",
    directory: repository,
    git: { defaultBranch: "main" },
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {} },
    accent: "none",
    isExpanded: true,
    addedAt: now(),
  };

  const folder: Project = {
    ...project,
    id: newProjectID(),
    name: "notes",
    directory: scratch.join("notes") as AbsolutePath,
  };
  delete folder.git;

  await database.projects.save(project);
  await database.projects.save(folder);

  const events = eventLog();
  const observer = recordingObserver(events);
  const { logger } = recordingLogger();
  const service = worktreeService(gitRunner());

  const projects = createProjectService({
    repository: database.projects,
    git: failingGit(),
    observer: observer.observer,
    sessions: { projectRemoving: (id) => sessions.projectRemoving(id) },
    log: logger,
  });
  await projects.load();

  const sessions = createSessionService({
    repository: database.sessions,
    projects,
    worktrees: service,
    terminals: createTerminalRegistry(),
    shell,
    observer: observer.observer,
    processes: scriptedProcesses().processes,
    createTerminal: fakeCreateTerminal(events).create,
    log: logger,
  });
  await sessions.load();

  return {
    sessions,
    database,
    service,
    project,
    folder,
    repository,
    scratch: (...components: string[]) => scratch.join(...components) as AbsolutePath,
    git: fixture.git,
    currentBranch: async () => (await fixture.git("rev-parse", "--abbrev-ref", "HEAD")).trim(),
    async [Symbol.asyncDispose](): Promise<void> {
      await database.dispose();
      await scratch[Symbol.asyncDispose]();
      await fixture[Symbol.asyncDispose]();
    },
  };
}

describe("branchOverview", () => {
  test("lists the branches, and marks the repository's own checkout", async () => {
    await using world = await setup("branches-main");
    await world.git("branch", "feat/a");

    const overview = await world.sessions.branchOverview(world.project.id);

    expect(overview.branches).toEqual(["feat/a", "main"]);
    expect(overview.worktrees).toEqual([
      { directory: world.repository, branch: "main", isMain: true },
    ]);
  });

  test("a linked worktree is listed with its branch and is not the main one", async () => {
    await using world = await setup("branches-linked");
    const linked = world.scratch("feat-b");
    await world.service.createWorktree({
      repository: world.repository,
      directory: linked,
      branch: "feat/b",
    });

    const overview = await world.sessions.branchOverview(world.project.id);

    expect(overview.branches).toEqual(["feat/b", "main"]);
    expect(overview.worktrees).toEqual([
      { directory: world.repository, branch: "main", isMain: true },
      { directory: linked, branch: "feat/b", isMain: false },
    ]);
  });

  test("a detached worktree carries no branch", async () => {
    await using world = await setup("branches-detached");
    const detached = world.scratch("spike");
    await world.service.createWorktree({ repository: world.repository, directory: detached });

    const overview = await world.sessions.branchOverview(world.project.id);
    const entry = overview.worktrees.find((candidate) => candidate.directory === detached);

    expect(entry).toEqual({ directory: detached, isMain: false });
  });

  test("a folder project is refused rather than answered with an empty list", async () => {
    await using world = await setup("branches-folder");

    const thrown = await rejection(world.sessions.branchOverview(world.folder.id));

    expect(thrown).toBeInstanceOf(WorktreesUnsupported);
  });

  test("a project that no longer exists is refused", async () => {
    await using world = await setup("branches-unknown");

    expect(await rejection(world.sessions.branchOverview(newProjectID()))).toBeInstanceOf(
      UnknownProject,
    );
  });
});

describe("createSession: inProject with a branch", () => {
  test("checks the branch out in the project's own directory", async () => {
    await using world = await setup("inproject-checkout");
    await world.git("branch", "feat/target");

    const session = await world.sessions.createSession({
      kind: "inProject",
      projectID: world.project.id,
      branch: "feat/target",
    });

    expect(await world.currentBranch()).toBe("feat/target");
    expect(session.directory).toBe(world.repository);
    expect(session.backing.kind).toBe("projectDirectory");
    expect(session.name).toBe("feat/target");
  });

  test("the branch already checked out is a no-op that still creates the session", async () => {
    await using world = await setup("inproject-same");

    const session = await world.sessions.createSession({
      kind: "inProject",
      projectID: world.project.id,
      branch: "main",
    });

    expect(await world.currentBranch()).toBe("main");
    expect(await world.database.sessions.all()).toHaveLength(1);
    expect(session.backing.kind).toBe("projectDirectory");
  });

  test("a branch that does not exist creates nothing", async () => {
    await using world = await setup("inproject-missing");

    const thrown = await rejection(
      world.sessions.createSession({
        kind: "inProject",
        projectID: world.project.id,
        branch: "feat/absent",
      }),
    );

    expect(thrown).toBeInstanceOf(GitFailure);
    expect(await world.database.sessions.all()).toEqual([]);
    expect(world.sessions.sessions).toEqual([]);
    expect(await world.currentBranch()).toBe("main");
  });

  test("a branch held by another worktree is refused, and nothing is created", async () => {
    await using world = await setup("inproject-held");
    await world.service.createWorktree({
      repository: world.repository,
      directory: world.scratch("held"),
      branch: "feat/held",
    });

    const thrown = await rejection(
      world.sessions.createSession({
        kind: "inProject",
        projectID: world.project.id,
        branch: "feat/held",
      }),
    );

    expect(thrown).toBeInstanceOf(GitFailure);
    expect(await world.database.sessions.all()).toEqual([]);
    expect(await world.currentBranch()).toBe("main");
  });

  test("no branch runs no git at all, and a folder project with one is refused", async () => {
    await using world = await setup("inproject-plain");

    const plain = await world.sessions.createSession({
      kind: "inProject",
      projectID: world.project.id,
    });

    expect(plain.backing.kind).toBe("projectDirectory");
    expect(await world.currentBranch()).toBe("main");

    const thrown = await rejection(
      world.sessions.createSession({
        kind: "inProject",
        projectID: world.folder.id,
        branch: "main",
      }),
    );

    expect(thrown).toBeInstanceOf(WorktreesUnsupported);
  });
});
