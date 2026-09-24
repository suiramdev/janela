import { describe, expect, test } from "bun:test";

import {
  absolutePath,
  emptyLayout,
  instant,
  newProjectID,
  newSessionID,
  now,
  type Backing,
  type ForgeItems,
  type ForgeState,
  type Project,
  type Session,
} from "@janela/core";
import type { ForgeServing } from "@janela/forge";
import type { GitWorktree } from "@janela/git";

import { createForgeOverview } from "./forge-overview.ts";
import { repositoryPath } from "./project-service.ts";

interface FakeForge {
  readonly forge: ForgeServing;
  readonly stateAsked: readonly Session[];
}

const repository = absolutePath("/Users/x/code/janela");

const worktreePath = absolutePath("/Users/x/code/.worktrees/feat-x");

const listed: ForgeItems = {
  viewer: "suiramdev",
  items: [
    {
      kind: "issue",
      number: 7,
      title: "the issue",
      state: "open",
      isDraft: false,
      url: "https://github.com/suiramdev/janela/issues/7",
      assignees: ["suiramdev"],
      reviewers: [],
      labels: [],
      updatedAt: instant("2026-09-20T10:00:00Z"),
    },
  ],
};

const pullRequestState: ForgeState = {
  host: "gitHub",
  pullRequest: {
    number: 42,
    title: "feat: x",
    state: "open",
    isDraft: false,
    url: "https://github.com/suiramdev/janela/pull/42",
  },
  checks: "passing",
  refreshedAt: instant("2026-09-22T15:00:00Z"),
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: repository,
    git: { forge: "gitHub", remoteURL: "git@github.com:suiramdev/janela.git" },
    settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {} },
    accent: "none",
    isExpanded: true,
    addedAt: now(),
    ...overrides,
  };
}

function session(owner: Project | undefined, backing: Backing, directory = repository): Session {
  const base: Session = {
    id: newSessionID(),
    name: "s",
    directory,
    backing,
    terminals: [],
    layout: emptyLayout,
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
  };

  return owner === undefined ? base : { ...base, projectID: owner.id };
}

function worktree(path: string, branch: string | undefined): GitWorktree {
  const entry: GitWorktree = {
    path: absolutePath(path),
    isBare: false,
    isDetached: branch === undefined,
    isPrunable: false,
  };

  return branch === undefined ? entry : { ...entry, branch };
}

function fakeForge(items: ForgeItems | undefined): FakeForge {
  const stateAsked: Session[] = [];

  return {
    forge: {
      isAvailable: async () => true,
      state: async (request) => {
        stateAsked.push(request.session);

        return pullRequestState;
      },
      items: async () => items,
      pullRequestBranch: async () => undefined,
    },
    stateAsked,
  };
}

describe("forge overview", () => {
  test("each session names the branch git says it is on, not the one it was created with", async () => {
    const owner = project();
    const simple = session(owner, { kind: "projectDirectory" });
    const moved = session(
      owner,
      {
        kind: "worktree",
        binding: {
          branch: "feat/old-name",
          path: worktreePath,
          ownership: "managed",
          includedPaths: [],
        },
      },
      worktreePath,
    );

    const standalone = session(undefined, { kind: "folder" }, absolutePath("/Users/x/notes"));
    const { forge } = fakeForge(listed);

    const overview = await createForgeOverview({
      projects: { projects: [owner] },
      sessions: { sessions: [simple, moved, standalone] },
      worktrees: {
        worktrees: async () => [worktree(repository, "main"), worktree(worktreePath, "feat/x")],
      },
      forge,
    }).overview();

    expect(overview.sessions.map((link) => link.branch)).toEqual(["main", "feat/x", undefined]);
    expect(overview.sessions[0]?.forge).toEqual(pullRequestState);
    expect(overview.sessions[2]?.forge).toBeUndefined();
  });

  test("a repository is named by its remote and carries the viewer and items", async () => {
    const owner = project();
    const { git: _none, ...folder } = project({ name: "notes" });
    const { forge } = fakeForge(listed);

    const overview = await createForgeOverview({
      projects: { projects: [owner, folder] },
      sessions: { sessions: [] },
      worktrees: { worktrees: async () => [] },
      forge,
    }).overview();

    expect(overview.repositories).toEqual([
      {
        projectID: owner.id,
        host: "gitHub",
        name: "suiramdev/janela",
        isAvailable: true,
        viewer: "suiramdev",
        items: listed.items,
      },
    ]);
  });

  test("an unusable CLI marks the repository unavailable and asks nothing per session", async () => {
    const owner = project();
    const simple = session(owner, { kind: "projectDirectory" });
    const recorded = fakeForge(undefined);

    const overview = await createForgeOverview({
      projects: { projects: [owner] },
      sessions: { sessions: [simple] },
      worktrees: { worktrees: async () => [worktree(repository, "main")] },
      forge: recorded.forge,
    }).overview();

    expect(overview.repositories[0]?.isAvailable).toBe(false);
    expect(overview.repositories[0]?.items).toEqual([]);
    expect(overview.sessions).toEqual([{ sessionID: simple.id, branch: "main" }]);
    expect(recorded.stateAsked).toEqual([]);
  });

  test("git failing to list worktrees costs the branch, not the overview", async () => {
    const owner = project();
    const simple = session(owner, { kind: "projectDirectory" });
    const { forge } = fakeForge(listed);

    const overview = await createForgeOverview({
      projects: { projects: [owner] },
      sessions: { sessions: [simple] },
      worktrees: {
        worktrees: async () => {
          throw new Error("not a git repository");
        },
      },
      forge,
    }).overview();

    expect(overview.sessions).toEqual([{ sessionID: simple.id, forge: pullRequestState }]);
  });
});

describe("repositoryPath", () => {
  test("scp-like, https and nested GitLab groups all reduce to the path", () => {
    expect(repositoryPath("git@github.com:suiramdev/janela.git")).toBe("suiramdev/janela");
    expect(repositoryPath("https://github.com/suiramdev/janela")).toBe("suiramdev/janela");
    expect(repositoryPath("https://gitlab.acme.io/a/b/c.git/")).toBe("a/b/c");
  });

  test("a remote with no path has no name", () => {
    expect(repositoryPath("https://github.com/")).toBeUndefined();
    expect(repositoryPath("not a url")).toBeUndefined();
  });
});
