import { describe, expect, test } from "bun:test";

import type {
  AbsolutePath,
  LaunchProfile,
  Project,
  ProjectID,
  SessionID,
  TerminalID,
} from "@janela/core";
import { absolutePath, newLaunchProfileID, newProjectID, now } from "@janela/core";
import type { TemporaryDatabase } from "@janela/db";
import { temporaryDatabase } from "@janela/db";
import { GitFailure, type GitWorktree, type WorktreeServing } from "@janela/git";
import type { TerminalRegistry } from "@janela/terminal";
import { createTerminalRegistry } from "@janela/terminal";
import { Effect } from "effect";

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
import { createProjectService, type ProjectRemovalObserving } from "./project-service.ts";
import {
  createSessionService,
  defaultWorktreeDirectory,
  worktreeSlug,
  type SessionService,
  type SessionServiceDependencies,
} from "./session-service.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import {
  eventLog,
  fakeAutomation,
  fakeCreateTerminal,
  fakeInclude,
  fakeWorktrees,
  failingGit,
  recordingLogger,
  recordingObserver,
  scriptedProcesses,
  type EventLog,
  type FakeAutomation,
  type FakeAutomationOptions,
  type FakeInclude,
  type FakeIncludeOptions,
  type FakeTerminalFactory,
  type FakeWorktreeOptions,
  type FakeWorktrees,
  type RecordedLog,
  type RecordingObserver,
} from "./test-fakes.ts";

interface Fixture {
  readonly database: TemporaryDatabase;
  readonly sessions: SessionService & ProjectRemovalObserving;
  readonly removeProject: (id: ProjectID) => Promise<void>;
  readonly observer: RecordingObserver;
  readonly events: EventLog;
  readonly worktrees: FakeWorktrees;
  readonly include: FakeInclude | undefined;
  readonly automation: FakeAutomation;
  readonly terminals: TerminalRegistry;
  readonly factory: FakeTerminalFactory;
  readonly records: readonly RecordedLog[];
  readonly project: Project;
  readonly folder: Project;
}

interface WithSessionsOptions {
  readonly include?: {
    readonly paths: readonly string[];
    readonly copied?: readonly string[];
    readonly failCopy?: Error;
  };
  readonly automation?: boolean;
  readonly automationAttaches?: boolean;
  readonly failCreate?: Error;
  readonly safety?: FakeWorktreeOptions["safety"];
  readonly listed?: readonly GitWorktree[];
  readonly project?: Partial<Project>;
  readonly profiles?: readonly LaunchProfile[];
}

type MutableWorktreeOptions = {
  -readonly [Key in keyof FakeWorktreeOptions]: FakeWorktreeOptions[Key];
};

type MutableIncludeOptions = {
  -readonly [Key in keyof FakeIncludeOptions]: FakeIncludeOptions[Key];
};

type MutableAutomationOptions = {
  -readonly [Key in keyof FakeAutomationOptions]: FakeAutomationOptions[Key];
};

type MutableSessionDependencies = {
  -readonly [Key in keyof SessionServiceDependencies]: SessionServiceDependencies[Key];
};

const repositoryDirectory = absolutePath("/Users/x/code/janela");

const folderDirectory = absolutePath("/Users/x/notes");

const unknownIdentifier = "00000000-0000-4000-8000-000000000000";

const canonicalise = (directory: AbsolutePath): AbsolutePath =>
  absolutePath(`/private${directory}`);

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-fish"],
};

const refusingWorktrees: WorktreeServing = {
  worktrees: () => {
    throw new Error("git must not run here");
  },
  branches: () => {
    throw new Error("git must not run here");
  },
  checkoutBranch: () => {
    throw new Error("git must not run here");
  },
  createWorktree: () => {
    throw new Error("git must not run here");
  },
  removalSafety: () => {
    throw new Error("git must not run here");
  },
  removeWorktree: () => {
    throw new Error("git must not run here");
  },
};

const projectRecord = (overrides: Partial<Project> = {}): Project => ({
  id: newProjectID(),
  name: "janela",
  directory: repositoryDirectory,
  git: { defaultBranch: "main" },
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {}, isForgeEnabled: true },
  accent: "none",
  isExpanded: true,
  addedAt: now(),
  ...overrides,
});

const rejection = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error("the call resolved instead of rejecting");
    },
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

const threeTabSession = async (fixture: Fixture): Promise<SessionID> => {
  const session = await fixture.sessions.createSession({
    kind: "inProject",
    projectID: fixture.project.id,
  });
  await fixture.sessions.createTerminal(session.id);
  await fixture.sessions.createTerminal(session.id);

  return session.id;
};

const storedTabOrder = async (fixture: Fixture, id: SessionID): Promise<readonly TerminalID[]> => {
  const stored = await fixture.database.sessions.find(id);

  return (stored?.layout.tabs ?? []).map((tab) => tab.focusedTerminalID);
};

const splitSession = async (
  fixture: Fixture,
): Promise<{ id: SessionID; first: TerminalID; second: TerminalID }> => {
  const session = await fixture.sessions.createSession({
    kind: "inProject",
    projectID: fixture.project.id,
  });
  const first = session.terminals[0]?.id as TerminalID;
  const added = await fixture.sessions.createTerminal(session.id, {
    placement: { kind: "split", beside: first, axis: "horizontal" },
  });

  return { id: session.id, first, second: added.id };
};

async function withSessions(
  options: WithSessionsOptions,
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const database = await temporaryDatabase();
  const events = eventLog();
  const observer = recordingObserver(events);
  const { logger, records } = recordingLogger();

  await Effect.runPromise(
    Effect.ensuring(
      Effect.tryPromise({
        try: async () => {
          const project = projectRecord(options.project);
          const folder = projectRecord({ name: "notes", directory: folderDirectory });
          delete folder.git;

          await Promise.all(
            (options.profiles ?? []).map((profile) => database.launchProfiles.save(profile)),
          );
          await database.projects.save(project);
          await database.projects.save(folder);

          const worktreeOptions: MutableWorktreeOptions = { canonicalise, events };

          if (options.listed !== undefined) worktreeOptions.listed = options.listed;

          if (options.failCreate !== undefined) worktreeOptions.failCreate = options.failCreate;

          if (options.safety !== undefined) worktreeOptions.safety = options.safety;

          const worktrees = fakeWorktrees(worktreeOptions);

          let include: FakeInclude | undefined;

          if (options.include !== undefined) {
            const includeOptions: MutableIncludeOptions = { paths: options.include.paths, events };

            if (options.include.copied !== undefined) {
              includeOptions.copied = options.include.copied;
            }

            if (options.include.failCopy !== undefined) {
              includeOptions.failCopy = options.include.failCopy;
            }

            include = fakeInclude(includeOptions);
          }

          const automationOptions: MutableAutomationOptions = { events };

          if (options.automationAttaches === true) automationOptions.attaches = true;

          const automation = fakeAutomation(automationOptions);

          const factory = fakeCreateTerminal(events);
          const terminals = createTerminalRegistry();

          const projects = createProjectService({
            repository: database.projects,
            git: failingGit(),
            observer: observer.observer,
            sessions: { projectRemoving: (id) => sessions.projectRemoving(id) },
            log: logger,
          });
          await projects.load();

          const dependencies: MutableSessionDependencies = {
            repository: database.sessions,
            profiles: database.launchProfiles,
            projects,
            worktrees: worktrees.worktrees,
            terminals,
            shell,
            observer: observer.observer,
            processes: scriptedProcesses({ which: { claude: "/opt/homebrew/bin/claude" } })
              .processes,
            createTerminal: factory.create,
            log: logger,
          };

          if (include !== undefined) dependencies.include = include.include;

          if (options.automation === true) dependencies.automation = automation.automation;

          const sessions = createSessionService(dependencies);
          await sessions.load();

          await work({
            database,
            sessions,
            removeProject: (id) => projects.removeProject(id),
            observer,
            events,
            worktrees,
            include,
            automation,
            terminals,
            factory,
            records,
            project,
            folder,
          });
        },
        catch: (cause: unknown) => cause,
      }),
      Effect.promise(() => database.dispose()),
    ),
  );
}

describe("createSession", () => {
  test("standalone: a folder, a name, and one terminal that is not running", async () => {
    await withSessions({ automation: true }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "standalone",
        directory: folderDirectory,
      });

      expect(session.projectID).toBeUndefined();
      expect(session.backing.kind).toBe("folder");
      expect(session.name).toBe("notes");
      expect(session.terminals).toHaveLength(1);
      expect(session.terminals[0]?.startsAutomatically).toBe(true);
      expect(session.terminals[0]?.role).toEqual({ kind: "user" });
      expect(fixture.terminals.inSession(session.id)).toEqual([]);
      expect(session.layout.tabs).toHaveLength(1);
      expect(fixture.observer.sessionCalls[0]?.[0]?.terminals).toEqual([]);

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.terminals).toHaveLength(1);
      expect(stored?.layout).toEqual(session.layout);
      expect(fixture.automation.runs).toEqual([]);
      expect(fixture.worktrees.created).toEqual([]);
    });
  });

  test("inProject: the project's own directory, and sessionStart only", async () => {
    await withSessions({ automation: true }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      expect(session.directory).toBe(repositoryDirectory);
      expect(session.backing.kind).toBe("projectDirectory");
      expect(session.name).toBe("janela");
      expect(fixture.automation.runs.map((run) => run.event)).toEqual(["sessionStart"]);
      expect(fixture.worktrees.created).toEqual([]);
      expect(fixture.worktrees.checkedOut).toEqual([]);
    });
  });

  test("newWorktree: the default directory, and git's path afterwards", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
      });

      expect(fixture.worktrees.created).toEqual([
        {
          repository: repositoryDirectory,
          directory: absolutePath("/Users/x/code/.worktrees/feature-x"),
          branch: "feature/x",
        },
      ]);
      expect(session.directory).toBe(absolutePath("/private/Users/x/code/.worktrees/feature-x"));

      const backing = session.backing;

      expect(backing.kind === "worktree" && backing.binding.path).toBe(session.directory);
      expect(backing.kind === "worktree" && backing.binding.ownership).toBe("managed");
      expect(backing.kind === "worktree" && backing.binding.branch).toBe("feature/x");
      expect(backing.kind === "worktree" && backing.binding.baseCommit).toBe(
        "9f2a1c4e5b6d7a8091b2c3d4e5f60718293a4b5c",
      );

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.directory).toBe(session.directory);
    });
  });

  test("newWorktree: an explicit directory and start point are passed through", async () => {
    await withSessions({}, async (fixture) => {
      await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "release",
        startPoint: "origin/main",
        directory: absolutePath("/Users/x/trees/release"),
        name: "Release prep",
      });

      expect(fixture.worktrees.created[0]).toEqual({
        repository: repositoryDirectory,
        directory: absolutePath("/Users/x/trees/release"),
        branch: "release",
        startPoint: "origin/main",
      });
    });
  });

  test("newWorktree: the name the user gave it decides the directory", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
        name: "review 2",
      });

      expect(fixture.worktrees.created[0]?.directory).toBe(
        absolutePath("/Users/x/code/.worktrees/review-2"),
      );
      expect(session.name).toBe("review 2");

      const backing = session.backing;

      expect(backing.kind === "worktree" && backing.binding.branch).toBe("feature/x");
    });
  });

  test("newWorktree: sharing a branch is forced only when it was asked for", async () => {
    await withSessions({}, async (fixture) => {
      await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
      });
      await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
        name: "second",
        shareBranch: true,
      });

      expect(fixture.worktrees.created.map((request) => request.force)).toEqual([undefined, true]);
    });
  });

  test("the documented order: persist, worktree, copy, worktreeCreated, sessionStart, terminal", async () => {
    await withSessions(
      { automation: true, include: { paths: [".env"], copied: [".env"] } },
      async (fixture) => {
        await fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.project.id,
          branch: "feature/x",
        });

        expect(fixture.events.entries).toEqual([
          "publish[t=0]",
          "worktree.create",
          "publish[t=0]",
          "include.copy",
          "publish[t=0]",
          "automation.worktreeCreated",
          "publish[t=0]",
          "automation.sessionStart",
          "publish[t=0]",
          "publish[t=1]",
        ]);
        expect(fixture.include?.copies[0]?.worktree).toBe(
          absolutePath("/private/Users/x/code/.worktrees/feature-x"),
        );
      },
    );
  });

  test("with neither include nor automation injected, creation still completes", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
      });

      expect(session.terminals).toHaveLength(1);
      expect(fixture.events.entries).toEqual([
        "publish[t=0]",
        "worktree.create",
        "publish[t=0]",
        "publish[t=1]",
      ]);
    });
  });

  test("a `.worktreeinclude` failure costs the copy, never the session", async () => {
    await withSessions(
      { automation: true, include: { paths: [".env"], failCopy: new Error("EACCES") } },
      async (fixture) => {
        const session = await fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.project.id,
          branch: "feature/x",
        });

        expect(session.terminals).toHaveLength(1);
        expect(fixture.automation.runs.map((run) => run.event)).toEqual([
          "worktreeCreated",
          "sessionStart",
        ]);
        expect(fixture.records.map((record) => record.message)).toContain(
          "worktreeinclude copy failed",
        );
      },
    );
  });

  test("an automation failure is logged and non-fatal", async () => {
    const events = eventLog();
    const automation = fakeAutomation({ events, fail: new Error("no such command") });
    const database = await temporaryDatabase();

    await Effect.runPromise(
      Effect.ensuring(
        Effect.tryPromise({
          try: async () => {
            const project = projectRecord();
            await database.projects.save(project);

            const observer = recordingObserver(events);
            const { logger, records } = recordingLogger();
            const projects = createProjectService({
              repository: database.projects,
              git: failingGit(),
              observer: observer.observer,
              sessions: { projectRemoving: async () => {} },
            });
            await projects.load();

            const sessions = createSessionService({
              repository: database.sessions,
              profiles: database.launchProfiles,
              projects,
              worktrees: fakeWorktrees({ canonicalise, events }).worktrees,
              terminals: createTerminalRegistry(),
              shell,
              observer: observer.observer,
              automation: automation.automation,
              createTerminal: fakeCreateTerminal(events).create,
              log: logger,
            });

            const session = await sessions.createSession({
              kind: "inProject",
              projectID: project.id,
            });

            expect(session.terminals).toHaveLength(1);
            expect(records.filter((record) => record.message === "automation failed")).toHaveLength(
              1,
            );
          },
          catch: (cause: unknown) => cause,
        }),
        Effect.promise(() => database.dispose()),
      ),
    );
  });

  test("an automation terminal lands in the session before the user's, and persists", async () => {
    await withSessions({ automation: true, automationAttaches: true }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      expect(session.terminals.map((terminal) => terminal.role)).toEqual([
        { kind: "automation", event: "sessionStart" },
        { kind: "user" },
      ]);
      expect(session.layout.tabs).toHaveLength(2);
      expect(session.layout.focusedTabIndex).toBe(1);
      expect(session.layout.tabs[0]?.focusedTerminalID).toBe(fixture.automation.attached[0]?.id);

      await fixture.sessions.load();
      const restored = fixture.sessions.find(session.id);

      expect(restored?.terminals.map((terminal) => terminal.role)).toEqual([
        { kind: "automation", event: "sessionStart" },
        { kind: "user" },
      ]);
      expect(restored?.terminals[0]?.startsAutomatically).toBe(false);
      expect(restored?.layout).toEqual(session.layout);
    });
  });

  test("a worktree git refuses leaves no session behind", async () => {
    const failure = new GitFailure(
      "worktree add",
      128,
      "fatal: 'feature/x' is already checked out",
    );

    await withSessions({ failCreate: failure, automation: true }, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.project.id,
          branch: "feature/x",
        }),
      );

      expect(thrown).toBe(failure);
      expect(fixture.sessions.sessions).toEqual([]);
      expect(await fixture.database.sessions.all()).toEqual([]);
      expect(fixture.observer.sessionCalls.map((call) => call.length)).toEqual([1, 0]);
      expect(fixture.automation.runs).toEqual([]);
    });
  });

  test("adoptWorktree: git's listing decides the branch, the commit and the path", async () => {
    const adopted: GitWorktree = {
      path: absolutePath("/Users/x/other/trees/spike"),
      head: "1111111111111111111111111111111111111111",
      branch: "spike",
      isBare: false,
      isDetached: false,
      isPrunable: false,
    };

    await withSessions({ listed: [adopted] }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "adoptWorktree",
        projectID: fixture.project.id,
        directory: adopted.path,
      });

      expect(session.name).toBe("spike");

      const backing = session.backing;

      expect(backing.kind === "worktree" && backing.binding.ownership).toBe("adopted");
      expect(backing.kind === "worktree" && backing.binding.branch).toBe("spike");
      expect(backing.kind === "worktree" && backing.binding.baseCommit).toBe(adopted.head);
      expect(fixture.worktrees.created).toEqual([]);

      const plan = await fixture.sessions.removalPlan(session.id);

      expect(plan.canDeleteDirectory).toBe(false);
    });
  });

  test("adoptWorktree: a directory git does not list is refused", async () => {
    await withSessions({ listed: [] }, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "adoptWorktree",
          projectID: fixture.project.id,
          directory: absolutePath("/Users/x/somewhere/else"),
        }),
      );

      expect(thrown).toBeInstanceOf(NotAWorktree);
      expect(await fixture.database.sessions.all()).toEqual([]);
    });
  });

  test("a project that is not a repository cannot have worktree sessions", async () => {
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.folder.id,
          branch: "feature/x",
        }),
      );

      expect(thrown).toBeInstanceOf(WorktreesUnsupported);
      expect(fixture.observer.sessionCalls).toEqual([]);
    });
  });

  test("an unknown project is refused before anything is written", async () => {
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "inProject",
          projectID: newProjectID(),
        }),
      );

      expect(thrown).toBeInstanceOf(UnknownProject);
      expect(await fixture.database.sessions.all()).toEqual([]);
    });
  });

  test("fromPullRequest is refused before anything is written", async () => {
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(
        fixture.sessions.createSession({
          kind: "fromPullRequest",
          projectID: fixture.project.id,
          number: 42,
        }),
      );

      expect(thrown).toBeInstanceOf(PullRequestsNotSupported);
      expect(await fixture.database.sessions.all()).toEqual([]);
      expect(fixture.observer.sessionCalls).toEqual([]);
    });
  });

  test("the first terminal takes the project's default profile", async () => {
    const profile: LaunchProfile = {
      id: newLaunchProfileID(),
      name: "Claude Code",
      iconName: "sparkles",
      command: ["claude"],
      environment: {},
      isAgent: true,
      isBuiltIn: false,
    };

    await withSessions(
      {
        profiles: [profile],
        project: { settings: { ...projectRecord().settings, defaultProfileID: profile.id } },
      },
      async (fixture) => {
        const session = await fixture.sessions.createSession({
          kind: "inProject",
          projectID: fixture.project.id,
        });

        expect(session.terminals[0]?.title).toBe("Claude Code");
        expect(session.terminals[0]?.profileID).toBe(profile.id);
      },
    );
  });
});

describe("removalPlan", () => {
  const uncommitted = { hasUncommittedChanges: true, hasUntrackedFiles: true };

  test("a managed worktree names what would be lost", async () => {
    await withSessions(
      {
        include: { paths: [".env"], copied: [".env"] },
        safety: uncommitted,
        project: {
          settings: {
            ...projectRecord().settings,
            automation: {
              sessionTeardown: { script: "docker compose down", timeoutSeconds: 30 },
            },
          },
        },
      },
      async (fixture) => {
        const session = await fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.project.id,
          branch: "feature/x",
        });

        const plan = await fixture.sessions.removalPlan(session.id);

        expect(plan.canDeleteDirectory).toBe(true);
        expect(plan.deletesDirectory).toBe(false);
        expect(plan.includedPaths).toEqual([".env"]);
        expect(plan.runsTeardownAutomation).toBe(true);
        expect(plan.safety.hasUncommittedChanges).toBe(true);
        expect(plan.liveTerminalCount).toBe(0);
        expect(plan.safety.hasRunningSessions).toBe(false);
      },
    );
  });

  test("a live terminal is something only this layer knows about", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
      });
      const terminal = session.terminals[0]?.id as TerminalID;
      await fixture.sessions.startTerminal(terminal);

      const running = await fixture.sessions.removalPlan(session.id);

      expect(running.safety.hasRunningSessions).toBe(true);
      expect(running.liveTerminalCount).toBe(1);

      fixture.factory.created[0]?.setState({ kind: "exited", code: 0 });
      const finished = await fixture.sessions.removalPlan(session.id);

      expect(finished.safety.hasRunningSessions).toBe(false);
      expect(finished.liveTerminalCount).toBe(0);
    });
  });

  test("a project-directory session is never ours to delete", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      const plan = await fixture.sessions.removalPlan(session.id);

      expect(plan.canDeleteDirectory).toBe(false);
      expect(plan.includedPaths).toEqual([]);
      expect(plan.runsTeardownAutomation).toBe(false);
      expect(plan.safety.hasUncommittedChanges).toBe(false);
    });
  });

  test("an unknown session is a user-facing error", async () => {
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(fixture.sessions.removalPlan(unknownIdentifier as SessionID));

      expect(thrown).toBeInstanceOf(UnknownSession);
    });
  });
});

describe("removeSession", () => {
  test("deletes the worktree only when the user ticked the box", async () => {
    await withSessions(
      { safety: { hasUncommittedChanges: true }, automation: true },
      async (fixture) => {
        const session = await fixture.sessions.createSession({
          kind: "newWorktree",
          projectID: fixture.project.id,
          branch: "feature/x",
        });
        const terminal = session.terminals[0]?.id as TerminalID;
        await fixture.sessions.startTerminal(terminal);

        const plan = await fixture.sessions.removalPlan(session.id);
        plan.deletesDirectory = true;
        await fixture.sessions.removeSession(session.id, plan);

        expect(fixture.worktrees.removed).toEqual([
          {
            directory: absolutePath("/private/Users/x/code/.worktrees/feature-x"),
            repository: repositoryDirectory,
            force: true,
          },
        ]);
        expect(fixture.factory.created[0]?.stops()).toBe(1);
        expect(fixture.terminals.get(terminal)).toBeUndefined();
        expect(fixture.terminals.liveCount).toBe(0);
        expect(await fixture.database.sessions.all()).toEqual([]);
        expect(fixture.sessions.sessions).toEqual([]);
        expect(fixture.observer.sessionCalls.at(-1)).toEqual([]);
      },
    );
  });

  test("a plan that asks to delete an adopted worktree is refused the deletion", async () => {
    const adopted: GitWorktree = {
      path: absolutePath("/Users/x/other/trees/spike"),
      head: "1111111111111111111111111111111111111111",
      branch: "spike",
      isBare: false,
      isDetached: false,
      isPrunable: false,
    };

    await withSessions({ listed: [adopted] }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "adoptWorktree",
        projectID: fixture.project.id,
        directory: adopted.path,
      });

      const plan = await fixture.sessions.removalPlan(session.id);
      plan.deletesDirectory = true;
      await fixture.sessions.removeSession(session.id, plan);

      expect(fixture.worktrees.removed).toEqual([]);
      expect(await fixture.database.sessions.all()).toEqual([]);
    });
  });

  test("teardown runs first, and a teardown that fails does not trap the session", async () => {
    const events = eventLog();
    const automation = fakeAutomation({ events, fail: new Error("compose exploded") });
    const database = await temporaryDatabase();

    await Effect.runPromise(
      Effect.ensuring(
        Effect.tryPromise({
          try: async () => {
            const project = projectRecord({
              settings: {
                ...projectRecord().settings,
                automation: {
                  sessionTeardown: { script: "docker compose down", timeoutSeconds: 30 },
                },
              },
            });
            await database.projects.save(project);

            const observer = recordingObserver(events);
            const worktrees = fakeWorktrees({ canonicalise, events });
            const projects = createProjectService({
              repository: database.projects,
              git: failingGit(),
              observer: observer.observer,
              sessions: { projectRemoving: async () => {} },
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
              automation: automation.automation,
              createTerminal: fakeCreateTerminal(events).create,
            });

            const session = await sessions.createSession({
              kind: "newWorktree",
              projectID: project.id,
              branch: "feature/x",
            });
            const plan = await sessions.removalPlan(session.id);

            expect(plan.runsTeardownAutomation).toBe(true);

            plan.deletesDirectory = true;

            await sessions.removeSession(session.id, plan);

            const teardown = events.entries.indexOf("automation.sessionTeardown");
            const removal = events.entries.indexOf("worktree.remove");

            expect(teardown).toBeGreaterThanOrEqual(0);
            expect(teardown).toBeLessThan(removal);
            expect(await database.sessions.all()).toEqual([]);
          },
          catch: (cause: unknown) => cause,
        }),
        Effect.promise(() => database.dispose()),
      ),
    );
  });
});

describe("projectRemoving", () => {
  test("removing a project stops its terminals and forgets its sessions", async () => {
    await withSessions({}, async (fixture) => {
      const inProject = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const standalone = await fixture.sessions.createSession({
        kind: "standalone",
        directory: folderDirectory,
      });
      await fixture.sessions.startTerminal(inProject.terminals[0]?.id as TerminalID);

      await fixture.removeProject(fixture.project.id);

      expect(fixture.sessions.sessions.map((session) => session.id)).toEqual([standalone.id]);
      expect(fixture.factory.created[0]?.stops()).toBe(1);
      expect(fixture.terminals.liveCount).toBe(0);
      expect((await fixture.database.sessions.all()).map((session) => session.id)).toEqual([
        standalone.id,
      ]);
    });
  });
});

describe("startTerminal", () => {
  test("registers once, starts the process, and touches the session", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const terminal = session.terminals[0]?.id as TerminalID;

      await fixture.sessions.startTerminal(terminal);
      await fixture.sessions.startTerminal(terminal);

      expect(fixture.factory.created).toHaveLength(1);
      expect(fixture.factory.created[0]?.starts()).toBe(2);
      expect(fixture.terminals.get(terminal)).toBeDefined();
      expect(fixture.factory.created[0]?.launch.executable).toBe("/opt/homebrew/bin/fish");
      expect(fixture.factory.created[0]?.launch.arguments).toEqual(["-fish"]);
      expect(fixture.factory.created[0]?.launch.workingDirectory).toBe(repositoryDirectory);
      expect(fixture.factory.created[0]?.launch.environment["JANELA_PROJECT"]).toBe("janela");

      const stored = await fixture.database.sessions.find(session.id);

      expect(Date.parse(stored?.lastActiveAt ?? "") > Date.parse(session.createdAt)).toBe(true);
    });
  });

  test("an unknown terminal is an error; stopping one that never ran is not", async () => {
    await withSessions({}, async (fixture) => {
      const unknown = unknownIdentifier as TerminalID;

      expect(await rejection(fixture.sessions.startTerminal(unknown))).toBeInstanceOf(
        UnknownTerminal,
      );

      await fixture.sessions.stopTerminal(unknown);
    });
  });

  test("restart hands the live terminal one operation, not a stop and a start", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const terminal = session.terminals[0]?.id as TerminalID;
      await fixture.sessions.startTerminal(terminal);

      await fixture.sessions.restartTerminal(terminal);

      expect(fixture.factory.created).toHaveLength(1);
      expect(fixture.factory.created[0]?.starts()).toBe(2);
      expect(fixture.factory.created[0]?.stops()).toBe(1);
    });
  });

  test("restarting a terminal that never ran starts it", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const terminal = session.terminals[0]?.id as TerminalID;

      await fixture.sessions.restartTerminal(terminal);

      expect(fixture.factory.created).toHaveLength(1);
      expect(fixture.factory.created[0]?.starts()).toBe(1);
      expect(fixture.terminals.get(terminal)).toBeDefined();
    });
  });

  test("restarting an unknown terminal is an error", async () => {
    await withSessions({}, async (fixture) => {
      const unknown = unknownIdentifier as TerminalID;

      expect(await rejection(fixture.sessions.restartTerminal(unknown))).toBeInstanceOf(
        UnknownTerminal,
      );
    });
  });
});

describe("createTerminal", () => {
  test("a second terminal arrives as a new focused tab, configured and not started", async () => {
    const profile: LaunchProfile = {
      id: newLaunchProfileID(),
      name: "Claude Code",
      iconName: "sparkles",
      command: ["claude"],
      environment: {},
      isAgent: true,
      isBuiltIn: false,
    };

    await withSessions({ profiles: [profile] }, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      const added = await fixture.sessions.createTerminal(session.id, { profileID: profile.id });

      expect(fixture.factory.created).toHaveLength(0);
      expect(fixture.terminals.get(added.id)).toBeUndefined();
      expect(added.title).toBe("Claude Code");
      expect(added.profileID).toBe(profile.id);

      const stored = await fixture.database.sessions.find(session.id);
      const first = session.terminals[0];

      if (first === undefined) throw new Error("the session has no first terminal");

      expect(stored?.terminals.map((terminal) => terminal.id)).toEqual([first.id, added.id]);
      expect(stored?.layout.tabs).toHaveLength(2);
      expect(stored?.layout.focusedTabIndex).toBe(1);
      expect(stored?.layout.tabs[1]?.focusedTerminalID).toBe(added.id);
    });
  });

  test("an unknown session, and a profile that has been deleted, are both refused", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const unknownSession = unknownIdentifier as SessionID;
      const goneProfile = newLaunchProfileID();

      expect(await rejection(fixture.sessions.createTerminal(unknownSession))).toBeInstanceOf(
        UnknownSession,
      );
      expect(
        await rejection(fixture.sessions.createTerminal(session.id, { profileID: goneProfile })),
      ).toBeInstanceOf(UnknownLaunchProfile);
      expect((await fixture.database.sessions.find(session.id))?.terminals).toHaveLength(1);
    });
  });

  test("a split placement divides the pane beside it, in one tab", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const first = session.terminals[0]?.id as TerminalID;

      const added = await fixture.sessions.createTerminal(session.id, {
        placement: { kind: "split", beside: first, axis: "horizontal" },
      });

      expect(fixture.factory.created).toHaveLength(0);

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.layout.tabs).toHaveLength(1);
      expect(stored?.layout.tabs[0]?.root).toMatchObject({
        kind: "split",
        axis: "horizontal",
        first: { kind: "terminal", id: first },
        second: { kind: "terminal", id: added.id },
      });
      expect(stored?.layout.tabs[0]?.focusedTerminalID).toBe(added.id);
      expect(stored?.terminals.map((terminal) => terminal.id)).toEqual([first, added.id]);
    });
  });

  test("a split beside a terminal of another session is refused", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const other = await fixture.sessions.createSession({
        kind: "standalone",
        directory: folderDirectory,
      });
      const elsewhere = other.terminals[0]?.id as TerminalID;

      expect(
        await rejection(
          fixture.sessions.createTerminal(session.id, {
            placement: { kind: "split", beside: elsewhere, axis: "vertical" },
          }),
        ),
      ).toBeInstanceOf(UnknownTerminal);
      expect((await fixture.database.sessions.find(session.id))?.terminals).toHaveLength(1);
    });
  });

  test("the seventh split is refused: MAXIMUM_PANE_DEPTH is a bound, not a preference", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      let beside = session.terminals[0]?.id as TerminalID;

      for (let index = 0; index < 5; index += 1) {
        // oxlint-disable-next-line no-await-in-loop
        const added = await fixture.sessions.createTerminal(session.id, {
          placement: { kind: "split", beside, axis: "horizontal" },
        });
        beside = added.id;
      }

      expect((await fixture.database.sessions.find(session.id))?.terminals).toHaveLength(6);
      expect(
        await rejection(
          fixture.sessions.createTerminal(session.id, {
            placement: { kind: "split", beside, axis: "horizontal" },
          }),
        ),
      ).toBeInstanceOf(LayoutTooDeep);
      expect((await fixture.database.sessions.find(session.id))?.terminals).toHaveLength(6);
    });
  });
});

describe("removeTerminal", () => {
  test("closing a running pane stops it and promotes its sibling", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const first = session.terminals[0]?.id as TerminalID;
      const added = await fixture.sessions.createTerminal(session.id, {
        placement: { kind: "split", beside: first, axis: "horizontal" },
      });
      await fixture.sessions.startTerminal(added.id);
      const live = fixture.factory.created[0];

      await fixture.sessions.removeTerminal(added.id);

      expect(live?.stops()).toBe(1);
      expect(fixture.terminals.get(added.id)).toBeUndefined();

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.terminals.map((terminal) => terminal.id)).toEqual([first]);
      expect(stored?.layout.tabs).toHaveLength(1);
      expect(stored?.layout.tabs[0]?.root).toEqual({ kind: "terminal", id: first });
    });
  });

  test("removing the only terminal leaves the session empty, and the session itself alone", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const only = session.terminals[0]?.id as TerminalID;

      await fixture.sessions.removeTerminal(only);

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.terminals).toEqual([]);
      expect(stored?.layout.tabs).toEqual([]);
      expect(fixture.terminals.liveCount).toBe(0);
      expect(fixture.sessions.sessions.map((candidate) => candidate.id)).toContain(session.id);
    });
  });

  test("a session emptied of terminals takes the next one as a fresh first tab", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const only = session.terminals[0]?.id as TerminalID;

      await fixture.sessions.removeTerminal(only);
      const added = await fixture.sessions.createTerminal(session.id);

      const stored = await fixture.database.sessions.find(session.id);

      expect(stored?.terminals.map((terminal) => terminal.id)).toEqual([added.id]);
      expect(stored?.layout.tabs).toHaveLength(1);
      expect(stored?.layout.focusedTabIndex).toBe(0);
    });
  });

  test("an unknown terminal is an error", async () => {
    await withSessions({}, async (fixture) => {
      const unknown = unknownIdentifier as TerminalID;

      expect(await rejection(fixture.sessions.removeTerminal(unknown))).toBeInstanceOf(
        UnknownTerminal,
      );
    });
  });
});

describe("moveTab", () => {
  test("persists the new order, so a later read of the session shows it", async () => {
    await withSessions({}, async (fixture) => {
      const id = await threeTabSession(fixture);
      const before = await storedTabOrder(fixture, id);

      await fixture.sessions.moveTab(id, 0, 2);

      const after = await storedTabOrder(fixture, id);

      expect(after).toEqual([...before.slice(1), ...before.slice(0, 1)]);
      expect(fixture.sessions.find(id)?.layout.tabs.map((tab) => tab.focusedTerminalID)).toEqual([
        ...after,
      ]);
    });
  });

  test("announces the move, because every client mirrors the order", async () => {
    await withSessions({}, async (fixture) => {
      const id = await threeTabSession(fixture);
      const announcements = fixture.observer.sessionCalls.length;

      await fixture.sessions.moveTab(id, 2, 0);

      expect(fixture.observer.sessionCalls.length).toBe(announcements + 1);
    });
  });

  test("a move that changes nothing writes nothing and announces nothing", async () => {
    await withSessions({}, async (fixture) => {
      const id = await threeTabSession(fixture);
      const before = await storedTabOrder(fixture, id);
      const announcements = fixture.observer.sessionCalls.length;

      await fixture.sessions.moveTab(id, 1, 1);
      await fixture.sessions.moveTab(id, 0, 9);
      await fixture.sessions.moveTab(id, -1, 0);

      expect(await storedTabOrder(fixture, id)).toEqual(before);
      expect(fixture.observer.sessionCalls.length).toBe(announcements);
    });
  });

  test("an unknown session is an error, not a silent no-op", async () => {
    await withSessions({}, async (fixture) => {
      const unknown = unknownIdentifier as SessionID;

      expect(await rejection(fixture.sessions.moveTab(unknown, 0, 1))).toBeInstanceOf(
        UnknownSession,
      );
    });
  });
});

describe("moveTerminal", () => {
  test("detaching a pane into a new tab persists, so a later read shows two tabs", async () => {
    await withSessions({}, async (fixture) => {
      const { id, first, second } = await splitSession(fixture);

      await fixture.sessions.moveTerminal(id, second, { kind: "newTab" });

      const stored = await fixture.database.sessions.find(id);

      expect(stored?.layout.tabs.map((tab) => tab.root)).toEqual([
        { kind: "terminal", id: first },
        { kind: "terminal", id: second },
      ]);
      expect(stored?.layout.focusedTabIndex).toBe(1);
      expect(fixture.sessions.find(id)?.layout.focusedTabIndex).toBe(1);
    });
  });

  test("announces the move, because every client mirrors the layout", async () => {
    await withSessions({}, async (fixture) => {
      const { id, first, second } = await splitSession(fixture);
      const announcements = fixture.observer.sessionCalls.length;

      await fixture.sessions.moveTerminal(id, second, {
        kind: "beside",
        terminal: first,
        edge: "left",
      });

      expect(fixture.observer.sessionCalls.length).toBe(announcements + 1);
      expect(fixture.sessions.find(id)?.layout.tabs[0]?.root).toMatchObject({
        first: { id: second },
        second: { id: first },
      });
    });
  });

  test("a move that changes nothing writes nothing and announces nothing", async () => {
    await withSessions({}, async (fixture) => {
      const id = await threeTabSession(fixture);
      const alone = fixture.sessions.find(id)?.terminals[0]?.id as TerminalID;
      const before = await storedTabOrder(fixture, id);
      const announcements = fixture.observer.sessionCalls.length;

      await fixture.sessions.moveTerminal(id, alone, { kind: "newTab" });
      await fixture.sessions.moveTerminal(id, alone, { kind: "tab", index: 0 });
      await fixture.sessions.moveTerminal(id, alone, { kind: "tab", index: 9 });

      expect(await storedTabOrder(fixture, id)).toEqual(before);
      expect(fixture.observer.sessionCalls.length).toBe(announcements);
    });
  });

  test("an unknown session or terminal is an error, not a silent no-op", async () => {
    await withSessions({}, async (fixture) => {
      const { id, first } = await splitSession(fixture);
      const other = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const elsewhere = other.terminals[0]?.id as TerminalID;
      const unknown = unknownIdentifier as SessionID;

      expect(
        await rejection(fixture.sessions.moveTerminal(unknown, first, { kind: "newTab" })),
      ).toBeInstanceOf(UnknownSession);
      expect(
        await rejection(fixture.sessions.moveTerminal(id, elsewhere, { kind: "newTab" })),
      ).toBeInstanceOf(UnknownTerminal);
      expect(
        await rejection(
          fixture.sessions.moveTerminal(id, first, {
            kind: "beside",
            terminal: elsewhere,
            edge: "right",
          }),
        ),
      ).toBeInstanceOf(UnknownTerminal);
    });
  });
});

describe("load", () => {
  test("restores sessions and starts nothing", async () => {
    await withSessions({}, async (fixture) => {
      const created = await fixture.sessions.createSession({
        kind: "newWorktree",
        projectID: fixture.project.id,
        branch: "feature/x",
      });
      await fixture.sessions.startTerminal(created.terminals[0]?.id as TerminalID);

      const registry = createTerminalRegistry();
      const restarted = createSessionService({
        repository: fixture.database.sessions,
        profiles: fixture.database.launchProfiles,
        projects: { find: () => undefined },
        worktrees: refusingWorktrees,
        terminals: registry,
        shell,
        observer: recordingObserver().observer,
        processes: scriptedProcesses().processes,
      });
      await restarted.load();

      expect(restarted.sessions.map((session) => session.id)).toEqual([created.id]);
      expect(registry.liveCount).toBe(0);
      expect(restarted.find(created.id)?.terminals).toHaveLength(1);
    });
  });
});

describe("rename", () => {
  test("persists and announces", async () => {
    await withSessions({}, async (fixture) => {
      const session = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });

      await fixture.sessions.rename(session.id, "Payments spike");

      expect((await fixture.database.sessions.find(session.id))?.name).toBe("Payments spike");
      expect(fixture.observer.sessionCalls.at(-1)?.[0]?.name).toBe("Payments spike");
    });
  });

  test("an unknown session is refused", async () => {
    await withSessions({}, async (fixture) => {
      const thrown = await rejection(fixture.sessions.rename(unknownIdentifier as SessionID, "x"));

      expect(thrown).toBeInstanceOf(UnknownSession);
    });
  });
});

describe("inProject and standaloneSessions", () => {
  test("partition the sessions by whether they have a project", async () => {
    await withSessions({}, async (fixture) => {
      const grouped = await fixture.sessions.createSession({
        kind: "inProject",
        projectID: fixture.project.id,
      });
      const alone = await fixture.sessions.createSession({
        kind: "standalone",
        directory: folderDirectory,
      });

      expect(fixture.sessions.inProject(fixture.project.id).map((s) => s.id)).toEqual([grouped.id]);
      expect(fixture.sessions.standaloneSessions.map((s) => s.id)).toEqual([alone.id]);
    });
  });
});

describe("worktreeSlug", () => {
  test("keeps a branch readable and keeps it one path component", () => {
    expect(worktreeSlug("feature/x")).toBe("feature-x");
    expect(worktreeSlug("Feature/JAN-42_fix")).toBe("Feature-JAN-42_fix");
    expect(worktreeSlug("release/1.2.3")).toBe("release-1.2.3");
    expect(worktreeSlug("feature//x")).toBe("feature-x");
    expect(worktreeSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(worktreeSlug("///")).toBe("worktree");
  });
});

describe("defaultWorktreeDirectory", () => {
  test("sits beside the repository, or under a chosen root", () => {
    const sibling = projectRecord();

    expect(defaultWorktreeDirectory(sibling, "feature/x")).toBe(
      absolutePath("/Users/x/code/.worktrees/feature-x"),
    );

    const custom = projectRecord({
      settings: {
        ...projectRecord().settings,
        worktreeRoot: { kind: "custom", directory: absolutePath("/Volumes/fast/trees") },
      },
    });

    expect(defaultWorktreeDirectory(custom, "feature/x")).toBe(
      absolutePath("/Volumes/fast/trees/feature-x"),
    );
  });
});
