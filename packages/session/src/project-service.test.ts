import { describe, expect, test } from "bun:test";

import type { AbsolutePath, Project, ProjectID } from "@janela/core";
import { absolutePath, supportsWorktrees } from "@janela/core";
import type { TemporaryDatabase } from "@janela/db";
import { temporaryDatabase } from "@janela/db";
import { temporaryDirectory } from "@janela/test-support";

import { ProjectAlreadyAdded, UnknownProject } from "./errors.ts";
import { createProjectService, forgeForRemote, type ProjectService } from "./project-service.ts";
import {
  failingGit,
  recordingLogger,
  recordingObserver,
  scriptedGit,
  type RecordedLog,
  type RecordingObserver,
  type ScriptedGit,
  type ScriptedGitOutcome,
} from "./test-fakes.ts";

interface Fixture {
  readonly projects: ProjectService;
  readonly database: TemporaryDatabase;
  readonly observer: RecordingObserver;
  readonly git: ScriptedGit;
  /** A real directory, because git detection compares realpaths. */
  readonly directory: AbsolutePath;
  readonly removed: readonly ProjectID[];
  readonly records: readonly RecordedLog[];
}

/** Answers keyed by argument prefix, built from the fixture's real directory. */
type Script = (directory: string) => Readonly<Record<string, ScriptedGitOutcome>>;

/**
 * A fixture with a real database and a real directory, and git scripted.
 *
 * Git is scripted rather than real here for one reason: the behaviour under test
 * is the *sequence* — announce, then detect, then announce again — and a real
 * `git remote get-url` cannot be held mid-flight to prove the first announcement
 * came first. `@janela/git` tests git itself, against real repositories.
 */
async function withProjects(
  options: { readonly script?: Script; readonly git?: ScriptedGit["git"] },
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  await using folder = await temporaryDirectory("project-service");
  const database = await temporaryDatabase();
  const observer = recordingObserver();
  const removed: ProjectID[] = [];
  const git = scriptedGit(options.script?.(folder.path));
  const { logger, records } = recordingLogger();

  try {
    const projects = createProjectService({
      repository: database.projects,
      git: options.git ?? git.git,
      observer: observer.observer,
      sessions: {
        async projectRemoving(id): Promise<void> {
          removed.push(id);
        },
      },
      log: logger,
    });
    await projects.load();

    await work({
      projects,
      database,
      observer,
      git,
      directory: absolutePath(folder.path),
      removed,
      records,
    });
  } finally {
    await database.dispose();
  }
}

/** A repository with an `origin` on GitHub. */
const repository: Script = (directory) => ({
  "rev-parse --show-toplevel": { standardOutput: `${directory}\n` },
  "remote get-url origin": { standardOutput: "git@github.com:suiramdev/janela.git\n" },
  "symbolic-ref --quiet --short refs/remotes/origin/HEAD": { standardOutput: "origin/main\n" },
});

describe("addProject", () => {
  test("the project appears before git has run, and again once detection settles", async () => {
    await withProjects({ script: repository }, async (fixture) => {
      const release = fixture.git.hold();

      const added = await fixture.projects.addProject({ directory: fixture.directory });

      // The user picked a directory and it is in the sidebar. `git` is absent,
      // because git has not been allowed to answer yet.
      expect(fixture.observer.projectCalls).toHaveLength(1);
      expect(fixture.observer.projectCalls[0]?.[0]?.id).toBe(added.id);
      expect(fixture.observer.projectCalls[0]?.[0]?.git).toBeUndefined();
      expect(fixture.git.calls.length).toBeGreaterThan(0);

      const settled = fixture.observer.nextProjects();
      release();
      const announced = await settled;

      expect(announced[0]?.git).toEqual({
        remoteURL: "git@github.com:suiramdev/janela.git",
        defaultBranch: "main",
        forge: "gitHub",
      });
      // And it survives the round trip, which is what a restart reads.
      expect((await fixture.database.projects.find(added.id))?.git?.defaultBranch).toBe("main");
    });
  });

  test("a plain folder announces a second time anyway, so a client stops waiting", async () => {
    // No scripted answers at all: `rev-parse --show-toplevel` fails, which is
    // exactly what a folder that is not a repository does.
    await withProjects({}, async (fixture) => {
      const added = await fixture.projects.addProject({ directory: fixture.directory });
      const announced = await fixture.observer.nextProjects();

      expect(announced[0]?.git).toBeUndefined();
      expect(supportsWorktrees(announced[0] as Project)).toBe(false);
      expect(fixture.projects.find(added.id)?.git).toBeUndefined();
    });
  });

  test("a repository with no remote still reads back as a repository", async () => {
    await withProjects(
      {
        script: (directory) => ({
          "rev-parse --show-toplevel": { standardOutput: `${directory}\n` },
          // No remote and no `origin/HEAD`: a local repository, which is an
          // ordinary thing to open.
          "symbolic-ref --quiet --short HEAD": { standardOutput: "trunk\n" },
        }),
      },
      async (fixture) => {
        const added = await fixture.projects.addProject({ directory: fixture.directory });
        await fixture.observer.nextProjects();

        // `defaultBranch` is what keeps the descriptor non-empty. Without it all
        // three columns are NULL, the row reads back as "not a repository", and
        // worktree sessions silently disappear after a restart.
        const stored = await fixture.database.projects.find(added.id);
        expect(stored?.git).toEqual({ defaultBranch: "trunk" });
        expect(supportsWorktrees(stored as Project)).toBe(true);
      },
    );
  });

  test("a repository with neither HEAD nor a remote falls back to a real branch", async () => {
    await withProjects(
      {
        script: (directory) => ({
          "rev-parse --show-toplevel": { standardOutput: `${directory}\n` },
          // Detached HEAD: `symbolic-ref` exits non-zero for both refs.
          "rev-parse --verify --quiet refs/heads/master": { standardOutput: "abc123\n" },
        }),
      },
      async (fixture) => {
        const added = await fixture.projects.addProject({ directory: fixture.directory });
        await fixture.observer.nextProjects();

        expect(fixture.projects.find(added.id)?.git?.defaultBranch).toBe("master");
      },
    );
  });

  test("a subdirectory of a repository is a folder, not that repository", async () => {
    await withProjects(
      {
        script: () => ({
          // git answers with the enclosing repository, which the user did not
          // pick — and `worktree add` there would target a repository they never
          // chose.
          "rev-parse --show-toplevel": { standardOutput: "/\n" },
          "remote get-url origin": { standardOutput: "git@github.com:x/y.git\n" },
        }),
      },
      async (fixture) => {
        const added = await fixture.projects.addProject({ directory: fixture.directory });
        await fixture.observer.nextProjects();

        expect(fixture.projects.find(added.id)?.git).toBeUndefined();
      },
    );
  });

  test("the name defaults to the directory's basename", async () => {
    await withProjects({}, async (fixture) => {
      const added = await fixture.projects.addProject({ directory: fixture.directory });

      expect(added.name).toBe(fixture.directory.split("/").at(-1) ?? "");
      expect(added.settings).toEqual({
        worktreeRoot: { kind: "siblingDirectory" },
        automation: [],
        isForgeEnabled: true,
      });
    });
  });

  test("the same directory twice is refused, and nothing is written or announced", async () => {
    await withProjects({}, async (fixture) => {
      await fixture.projects.addProject({ directory: fixture.directory });
      const announcements = fixture.observer.projectCalls.length;

      const thrown = await fixture.projects.addProject({ directory: fixture.directory }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(ProjectAlreadyAdded);
      expect(await fixture.database.projects.all()).toHaveLength(1);
      expect(fixture.observer.projectCalls).toHaveLength(announcements);
    });
  });

  test("a git that cannot run at all is logged as a shape and costs nothing else", async () => {
    await withProjects({ git: failingGit() }, async (fixture) => {
      // Resolves: detection is opportunistic, and a project is usable without it.
      const added = await fixture.projects.addProject({ directory: fixture.directory });
      // The refresh is deliberately not awaited; give the microtask queue its turn.
      await Promise.resolve();
      await Promise.resolve();

      expect(fixture.projects.find(added.id)).toBeDefined();
      expect(fixture.records.map((record) => record.message)).toEqual([
        "project git refresh failed",
      ]);
      expect(fixture.records[0]?.fields).toEqual({ project: added.id, reason: "Error" });
    });
  });
});

describe("load", () => {
  test("restores projects, including their git facts, without touching git", async () => {
    await withProjects({ script: repository }, async (fixture) => {
      const added = await fixture.projects.addProject({ directory: fixture.directory });
      await fixture.observer.nextProjects();

      // A daemon start: the database is warm, git is not consulted, and a git
      // that throws must not stop the first client from getting a snapshot.
      const restarted = createProjectService({
        repository: fixture.database.projects,
        git: failingGit(),
        observer: recordingObserver().observer,
        sessions: { projectRemoving: async () => {} },
      });
      await restarted.load();

      expect(restarted.projects.map((project) => project.id)).toEqual([added.id]);
      expect(restarted.find(added.id)?.git?.defaultBranch).toBe("main");
    });
  });
});

describe("removeProject", () => {
  test("the session side is told before the row is gone", async () => {
    await withProjects({}, async (fixture) => {
      const added = await fixture.projects.addProject({ directory: fixture.directory });
      await fixture.observer.nextProjects();

      await fixture.projects.removeProject(added.id);

      expect(fixture.removed).toEqual([added.id]);
      expect(fixture.projects.projects).toEqual([]);
      expect(await fixture.database.projects.all()).toEqual([]);
      // The whole remaining list, not a delta: a partial update cannot express a
      // deletion, so the brain always announces what is left.
      expect(fixture.observer.projectCalls.at(-1)).toEqual([]);
    });
  });

  test("an unknown project is a user-facing error, not a silent no-op", async () => {
    await withProjects({}, async (fixture) => {
      const thrown = await fixture.projects
        .removeProject("00000000-0000-4000-8000-000000000000" as ProjectID)
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(UnknownProject);
    });
  });
});

describe("updateSettings", () => {
  test("replaces the settings, persists them and announces", async () => {
    await withProjects({}, async (fixture) => {
      const worktreeRoot = { kind: "custom", directory: absolutePath("/Users/x/trees") } as const;
      const added = await fixture.projects.addProject({ directory: fixture.directory });
      await fixture.observer.nextProjects();

      await fixture.projects.updateSettings(added.id, {
        worktreeRoot,
        automation: [],
        isForgeEnabled: false,
      });

      const stored = await fixture.database.projects.find(added.id);
      expect(stored?.settings.worktreeRoot).toEqual(worktreeRoot);
      expect(stored?.settings.isForgeEnabled).toBe(false);
      expect(fixture.observer.projectCalls.at(-1)?.[0]?.settings.isForgeEnabled).toBe(false);
    });
  });
});

describe("forgeForRemote", () => {
  test("recognises the hosts it can, and nothing else", () => {
    expect(forgeForRemote("git@github.com:suiramdev/janela.git")).toBe("gitHub");
    expect(forgeForRemote("https://github.com/suiramdev/janela")).toBe("gitHub");
    expect(forgeForRemote("ssh://git@gitlab.corp.example:2222/group/project.git")).toBe("gitLab");
    expect(forgeForRemote("https://gitlab.com/group/project.git")).toBe("gitLab");
    // A GitLab install nobody named `gitlab` is indistinguishable from any other
    // host, and probing one to find out is not something we do.
    expect(forgeForRemote("https://bitbucket.org/x/y")).toBeUndefined();
    expect(forgeForRemote("not a url")).toBeUndefined();
  });
});
