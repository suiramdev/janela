import { describe, expect, test } from "bun:test";

import type { AbsolutePath, Project } from "@janela/core";
import { absolutePath, newProjectID, now } from "@janela/core";
import type { TemporaryDatabase } from "@janela/db";
import { temporaryDatabase } from "@janela/db";
import type { ForgeServing, ForgeState } from "@janela/forge";
import { PullRequestUnavailable } from "@janela/forge";
import { createTerminalRegistry } from "@janela/terminal";

import { WorktreesUnsupported } from "./errors.ts";
import { createProjectService } from "./project-service.ts";
import { createSessionService, defaultWorktreeDirectory } from "./session-service.ts";
import type { SessionService } from "./session-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import {
  eventLog,
  fakeCreateTerminal,
  fakeWorktrees,
  failingGit,
  recordingLogger,
  recordingObserver,
  scriptedProcesses,
  type FakeWorktrees,
  type RecordingObserver,
} from "./test-fakes.ts";

/**
 * `fromPullRequest`, which is the only creation kind that asks something outside
 * the daemon a question first.
 *
 * A separate file from `session-service.test.ts` on purpose: what is under test
 * here is the *seam* — that the head branch feeds the ordinary worktree path with
 * a start point, and that a pull request we could not resolve writes nothing.
 * `@janela/forge` owns whether `gh` answers.
 */

const repositoryDirectory = absolutePath("/Users/x/code/janela");
const folderDirectory = absolutePath("/Users/x/notes");

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-fish"],
};

const canonicalise = (directory: AbsolutePath): AbsolutePath =>
  absolutePath(`/private${directory}`);

const projectRecord = (overrides?: Partial<Project>): Project => ({
  id: newProjectID(),
  name: "janela",
  directory: repositoryDirectory,
  git: { forge: "gitHub", defaultBranch: "main" },
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: [], isForgeEnabled: true },
  accent: "none",
  isExpanded: true,
  addedAt: now(),
  ...overrides,
});

interface RecordedForge {
  readonly forge: ForgeServing;
  readonly asked: readonly { readonly project: Project; readonly number: number }[];
}

/** A `ForgeServing` that answers one branch, or nothing, and records the question. */
function recordingForge(branch: string | undefined): RecordedForge {
  const asked: { project: Project; number: number }[] = [];
  return {
    forge: {
      async isAvailable(): Promise<boolean> {
        return true;
      },
      async state(): Promise<ForgeState | undefined> {
        throw new Error("state must not be read while creating a session");
      },
      async pullRequestBranch(request): Promise<string | undefined> {
        asked.push({ project: request.project, number: request.number });
        return branch;
      },
    },
    asked,
  };
}

interface Fixture {
  readonly sessions: SessionService;
  readonly database: TemporaryDatabase;
  readonly observer: RecordingObserver;
  readonly worktrees: FakeWorktrees;
  readonly project: Project;
  readonly folder: Project;
  readonly asked: readonly { readonly project: Project; readonly number: number }[];
}

async function withSessions(
  options: { readonly branch?: string; readonly forge?: boolean },
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const database = await temporaryDatabase();
  const events = eventLog();
  const observer = recordingObserver(events);
  const { logger } = recordingLogger();
  const forge = recordingForge(options.branch);

  try {
    const project = projectRecord();
    const folder = projectRecord({ name: "notes", directory: folderDirectory });
    delete folder.git;
    await database.projects.save(project);
    await database.projects.save(folder);

    const worktrees = fakeWorktrees({ canonicalise, events });
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
      profiles: database.launchProfiles,
      projects,
      worktrees: worktrees.worktrees,
      terminals: createTerminalRegistry(),
      shell,
      observer: observer.observer,
      processes: scriptedProcesses().processes,
      createTerminal: fakeCreateTerminal(events).create,
      log: logger,
      ...(options.forge === false ? {} : { forge: forge.forge }),
    });
    await sessions.load();

    await work({
      sessions,
      database,
      observer,
      worktrees,
      project,
      folder,
      asked: forge.asked,
    });
  } finally {
    await database.dispose();
  }
}

const rejection = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("createSession: fromPullRequest", () => {
  test("the head branch becomes an ordinary worktree session", async () => {
    await withSessions({ branch: "feat/x" }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "fromPullRequest",
        projectID: fixture.project.id,
        number: 42,
      });

      expect(session.name).toBe("feat/x");
      expect(session.projectID).toBe(fixture.project.id);
      expect(session.backing).toEqual({
        kind: "worktree",
        binding: {
          branch: "feat/x",
          baseCommit: "9f2a1c4e5b6d7a8091b2c3d4e5f60718293a4b5c",
          path: canonicalise(defaultWorktreeDirectory(fixture.project, "feat/x")),
          ownership: "managed",
          includedPaths: [],
        },
      });
      expect(fixture.asked).toEqual([{ project: fixture.project, number: 42 }]);
    });
  });

  test("the worktree is cut from origin/<branch>, not from HEAD", async () => {
    await withSessions({ branch: "feat/x" }, async (fixture) => {
      await fixture.sessions.createSession({
        kind: "fromPullRequest",
        projectID: fixture.project.id,
        number: 42,
      });

      // Without a start point `git worktree add -b` branches off whatever HEAD
      // is, which would look like the pull request and contain none of it.
      expect(fixture.worktrees.created).toEqual([
        {
          repository: repositoryDirectory,
          directory: defaultWorktreeDirectory(fixture.project, "feat/x"),
          branch: "feat/x",
          startPoint: "origin/feat/x",
        },
      ]);
    });
  });

  test("a pull request that resolved to nothing writes nothing", async () => {
    // No branch configured: the forge answers `undefined`.
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "fromPullRequest",
          projectID: fixture.project.id,
          number: 42,
        }),
      );

      expect(thrown).toBeInstanceOf(PullRequestUnavailable);
      expect((thrown as PullRequestUnavailable).number).toBe(42);
      expect(await fixture.database.sessions.all()).toEqual([]);
      expect(fixture.observer.sessionCalls).toEqual([]);
      expect(fixture.worktrees.created).toEqual([]);
    });
  });

  test("a folder project is refused before the forge is asked anything", async () => {
    await withSessions({ branch: "feat/x" }, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "fromPullRequest",
          projectID: fixture.folder.id,
          number: 42,
        }),
      );

      expect(thrown).toBeInstanceOf(WorktreesUnsupported);
      expect(fixture.asked).toEqual([]);
      expect(await fixture.database.sessions.all()).toEqual([]);
    });
  });
});
