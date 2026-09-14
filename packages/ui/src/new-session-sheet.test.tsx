import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import type { BranchOverview } from "@janela/protocol";
import { renderToStaticMarkup } from "react-dom/server";

import {
  defaultStart,
  newSessionIntent,
  NewSessionSheet,
  preselectedBranch,
  standaloneIntent,
  startChoices,
  type NewSessionSheetProps,
} from "./new-session-sheet.tsx";
import { fakeFolderProject, fakeProject, fakeSession } from "./test-fakes.ts";

const noop = (): void => {};

const REPO = absolutePath("/repos/janela");
const WORKTREE = absolutePath("/repos/.worktrees/fix-pty");

/** `main` in the project directory, `fix/pty` in a linked worktree, `idea` nowhere. */
const OVERVIEW: BranchOverview = {
  branches: ["main", "fix/pty", "idea"],
  worktrees: [
    { directory: REPO, branch: "main", isMain: true },
    { directory: WORKTREE, branch: "fix/pty", isMain: false },
  ],
};

const project = fakeProject({ directory: REPO });
const NO_SESSIONS: readonly never[] = [];
const LOADED = { kind: "loaded", overview: OVERVIEW } as const;
const FAILED = { kind: "failed", summary: "Not a git repository." } as const;

function refusals(branch: string, sessions = [] as const): Record<string, string | undefined> {
  return Object.fromEntries(
    startChoices(branch, OVERVIEW, sessions).map((choice) => [choice.start, choice.refusal]),
  );
}

describe("startChoices", () => {
  test("a branch nobody holds may be checked out or given a new worktree", () => {
    expect(refusals("idea")).toEqual({
      checkout: undefined,
      existingWorktree: "No worktree has this branch.",
      newWorktree: undefined,
    });
    expect(defaultStart(startChoices("idea", OVERVIEW, []))).toBe("checkout");
  });

  test("the branch the project directory holds cannot get a worktree", () => {
    // git refuses a second checkout of a branch, so the dialog refuses first.
    expect(refusals("main")).toEqual({
      checkout: undefined,
      existingWorktree: "No worktree has this branch.",
      newWorktree: "Already checked out in the project directory.",
    });
  });

  test("a branch in a linked worktree can only use that worktree", () => {
    expect(refusals("fix/pty")).toEqual({
      checkout: `Checked out in the worktree at ${WORKTREE}.`,
      existingWorktree: undefined,
      newWorktree: "Already has a worktree.",
    });
    expect(defaultStart(startChoices("fix/pty", OVERVIEW, []))).toBe("existingWorktree");
  });

  test("a worktree that is already a session is not offered twice", () => {
    const open = fakeSession({ name: "fix/pty", directory: WORKTREE });
    const choices = startChoices("fix/pty", OVERVIEW, [open]);
    expect(choices.find((choice) => choice.start === "existingWorktree")?.refusal).toBe(
      'Already open as the session "fix/pty".',
    );
    expect(defaultStart(choices)).toBeUndefined();
  });
});

describe("newSessionIntent", () => {
  test("each start is a different creation case of the same request", () => {
    expect(newSessionIntent(project.id, "idea", "checkout", OVERVIEW, [])).toEqual({
      kind: "inProject",
      projectID: project.id,
      branch: "idea",
    });
    expect(newSessionIntent(project.id, "fix/pty", "existingWorktree", OVERVIEW, [])).toEqual({
      kind: "adoptWorktree",
      projectID: project.id,
      directory: WORKTREE,
    });
    expect(newSessionIntent(project.id, "idea", "newWorktree", OVERVIEW, [])).toEqual({
      kind: "newWorktree",
      projectID: project.id,
      branch: "idea",
    });
  });

  test("a refused start yields nothing rather than a request git would refuse", () => {
    expect(newSessionIntent(project.id, "main", "newWorktree", OVERVIEW, [])).toBeUndefined();
    expect(newSessionIntent(project.id, "fix/pty", "checkout", OVERVIEW, [])).toBeUndefined();
    expect(newSessionIntent(project.id, "idea", "existingWorktree", OVERVIEW, [])).toBeUndefined();
  });
});

describe("preselectedBranch", () => {
  test("the default branch, then the project directory's, then the first", () => {
    expect(preselectedBranch(project, OVERVIEW)).toBe("main");
    expect(
      preselectedBranch(fakeFolderProject(), {
        ...OVERVIEW,
        worktrees: [{ directory: REPO, branch: "fix/pty", isMain: true }],
      }),
    ).toBe("fix/pty");
    expect(preselectedBranch(fakeFolderProject(), { branches: ["z", "a"], worktrees: [] })).toBe(
      "z",
    );
  });
});

describe("standaloneIntent", () => {
  test("a folder is a path or nothing; the daemon decides whether it exists", () => {
    expect(standaloneIntent("  /tmp/notes ")).toEqual({
      kind: "standalone",
      directory: absolutePath("/tmp/notes"),
    });
    expect(standaloneIntent("")).toBeUndefined();
    expect(standaloneIntent("notes")).toBeUndefined();
  });
});

const FOLDER = fakeFolderProject();
const PROJECTS = [project, FOLDER] as const;
const noPick = (): Promise<undefined> => Promise.resolve(undefined);

/** Whether "Create Session" is offered: a refused start is also `disabled`. */
function canCreate(markup: string): boolean {
  const button = /<button[^>]*>Create Session<\/button>/.exec(markup)?.[0];
  if (button === undefined) throw new Error("no Create Session button");
  return !/\sdisabled=""/.test(button);
}

function render(overrides: Partial<NewSessionSheetProps>): string {
  return renderToStaticMarkup(
    <NewSessionSheet
      projects={PROJECTS}
      projectID={project.id}
      onProjectChange={noop}
      overview={LOADED}
      sessions={NO_SESSIONS}
      onPickDirectory={noPick}
      onCreate={noop}
      onCancel={noop}
      {...overrides}
    />,
  );
}

describe("the sheet", () => {
  test("a repository opens on its default branch with a refused start explained", () => {
    const markup = render({});
    expect(markup).toContain("No project");
    expect(markup).toContain('value="main"');
    expect(markup).toContain("Already checked out in the project directory.");
    expect(canCreate(markup)).toBe(true);
  });

  test("no project asks for a folder, and offers to create once there is one", () => {
    const markup = render({ projectID: undefined });
    expect(markup).toContain("Folder");
    expect(markup).toContain("Choose…");
    expect(markup).not.toContain("Branch");
    expect(canCreate(markup)).toBe(false);
  });

  test("a plain folder project asks nothing more and can be created", () => {
    const markup = render({ projectID: FOLDER.id, overview: FAILED });
    expect(markup).toContain(FOLDER.directory);
    expect(markup).not.toContain("Not a git repository.");
    expect(canCreate(markup)).toBe(true);
  });

  test("says why when the daemon could not answer, and keeps the project switchable", () => {
    const markup = render({ overview: FAILED });
    expect(markup).toContain("Not a git repository.");
    expect(markup).toContain("No project");
    expect(canCreate(markup)).toBe(false);
  });
});
