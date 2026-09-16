import { describe, expect, test } from "bun:test";

import { absolutePath } from "@janela/core";
import type { BranchOverview } from "@janela/protocol";
import { renderToStaticMarkup } from "react-dom/server";

import {
  defaultStart,
  newSessionIntent,
  NewSessionSheet,
  preselectedBranch,
  preselectedWorktree,
  standaloneIntent,
  startChoices,
  worktreesFor,
  type NewSessionSheetProps,
  type SessionDraft,
  type SessionStart,
} from "./new-session-sheet.tsx";
import { fakeFolderProject, fakeProject, fakeSession } from "./test-fakes.ts";

const noop = (): void => {};

const REPO = absolutePath("/repos/janela");
const WORKTREE = absolutePath("/repos/.worktrees/fix-pty");
const SECOND = absolutePath("/repos/.worktrees/review");

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

function detail(branch: string, start: SessionStart): string | undefined {
  return startChoices(branch, OVERVIEW, []).find((choice) => choice.start === start)?.detail;
}

/** A draft as the form resolves one: the worktree follows the branch. */
function draft(branch: string, start: SessionStart, overrides: Partial<SessionDraft> = {}) {
  return { branch, start, worktree: branch, startPoint: "main", ...overrides };
}

describe("startChoices", () => {
  test("two starts: the project's own directory, or a worktree", () => {
    expect(startChoices("idea", OVERVIEW, []).map((choice) => choice.start)).toEqual([
      "checkout",
      "worktree",
    ]);
  });

  test("a branch nobody holds may be checked out or given a worktree", () => {
    expect(refusals("idea")).toEqual({ checkout: undefined, worktree: undefined });
    expect(defaultStart(startChoices("idea", OVERVIEW, []))).toBe("checkout");
  });

  test("the branch the project directory holds can still be given a worktree", () => {
    expect(refusals("main")).toEqual({ checkout: undefined, worktree: undefined });
    expect(detail("main", "checkout")).toBe("Already checked out there.");
  });

  test("a branch in a linked worktree cannot be checked out again, so a worktree it is", () => {
    expect(refusals("fix/pty")).toEqual({
      checkout: `Checked out in the worktree at ${WORKTREE}.`,
      worktree: undefined,
    });
    expect(detail("fix/pty", "worktree")).toBe(
      "The worktree this branch already has, or a new one you name.",
    );
    expect(defaultStart(startChoices("fix/pty", OVERVIEW, []))).toBe("worktree");
  });

  test("a name no branch has arrives with a worktree, never in the project directory", () => {
    expect(refusals("spike/parser")).toEqual({
      checkout: "This branch does not exist yet.",
      worktree: undefined,
    });
    expect(defaultStart(startChoices("spike/parser", OVERVIEW, []))).toBe("worktree");
  });
});

describe("worktreesFor", () => {
  test("the linked checkouts of one branch, named by their directory, minus the project's own", () => {
    expect(worktreesFor("fix/pty", OVERVIEW, [])).toEqual([
      { directory: WORKTREE, name: "fix-pty" },
    ]);
    // The project directory is the other start, not a worktree to adopt.
    expect(worktreesFor("main", OVERVIEW, [])).toEqual([]);
    expect(worktreesFor("idea", OVERVIEW, [])).toEqual([]);
  });

  test("a worktree already open as a session says so, and stays in the list", () => {
    const open = fakeSession({ name: "fix/pty", directory: WORKTREE });
    expect(worktreesFor("fix/pty", OVERVIEW, [open])).toEqual([
      { directory: WORKTREE, name: "fix-pty", openAs: "fix/pty" },
    ]);
  });
});

describe("preselectedWorktree", () => {
  test("the first free worktree of the branch, else the branch's own name", () => {
    expect(preselectedWorktree("fix/pty", OVERVIEW, [])).toBe(WORKTREE);
    expect(preselectedWorktree("idea", OVERVIEW, [])).toBe("idea");

    const open = fakeSession({ name: "fix/pty", directory: WORKTREE });
    // Every worktree taken: the field offers a name for a new one instead of a
    // path that cannot be adopted.
    expect(preselectedWorktree("fix/pty", OVERVIEW, [open])).toBe("fix/pty");
  });
});

describe("newSessionIntent", () => {
  test("the project directory, when the branch may be checked out there", () => {
    expect(newSessionIntent(project.id, draft("idea", "checkout"), OVERVIEW, [])).toEqual({
      kind: "inProject",
      projectID: project.id,
      branch: "idea",
    });
  });

  test("a worktree the field picked is adopted; a name it was given is created", () => {
    expect(
      newSessionIntent(
        project.id,
        draft("fix/pty", "worktree", { worktree: WORKTREE }),
        OVERVIEW,
        [],
      ),
    ).toEqual({ kind: "adoptWorktree", projectID: project.id, directory: WORKTREE });

    expect(newSessionIntent(project.id, draft("idea", "worktree"), OVERVIEW, [])).toEqual({
      kind: "newWorktree",
      projectID: project.id,
      branch: "idea",
      name: "idea",
    });
  });

  test("the new worktree carries the name the field was given, trimmed", () => {
    expect(
      newSessionIntent(
        project.id,
        draft("idea", "worktree", { worktree: "  review  " }),
        OVERVIEW,
        [],
      ),
    ).toEqual({ kind: "newWorktree", projectID: project.id, branch: "idea", name: "review" });
  });

  test("an unnamed worktree, or a path that is not one to adopt, sends nothing", () => {
    expect(
      newSessionIntent(project.id, draft("idea", "worktree", { worktree: "   " }), OVERVIEW, []),
    ).toBeUndefined();
    // Already a session: the row is disabled, and a path is never read as a
    // name — `.worktrees/repos-.worktrees-fix-pty` is nobody's intent.
    const open = fakeSession({ name: "fix/pty", directory: WORKTREE });
    expect(
      newSessionIntent(project.id, draft("fix/pty", "worktree", { worktree: WORKTREE }), OVERVIEW, [
        open,
      ]),
    ).toBeUndefined();
    expect(newSessionIntent(project.id, draft("  ", "worktree"), OVERVIEW, [])).toBeUndefined();
  });

  test("only a branch being created carries a start point", () => {
    expect(newSessionIntent(project.id, draft("spike/parser", "worktree"), OVERVIEW, [])).toEqual({
      kind: "newWorktree",
      projectID: project.id,
      branch: "spike/parser",
      name: "spike/parser",
      startPoint: "main",
    });
    // An existing branch is checked out where it already points; a start point
    // would be a second opinion git has no use for.
    expect(
      Object.keys(newSessionIntent(project.id, draft("idea", "worktree"), OVERVIEW, []) ?? {}),
    ).not.toContain("startPoint");
  });

  test("sharing a branch is asked for explicitly, never inferred by the daemon", () => {
    expect(
      newSessionIntent(project.id, draft("main", "worktree", { worktree: "review" }), OVERVIEW, []),
    ).toEqual({
      kind: "newWorktree",
      projectID: project.id,
      branch: "main",
      name: "review",
      shareBranch: true,
    });
    expect(
      newSessionIntent(
        project.id,
        draft("fix/pty", "worktree", { worktree: "second" }),
        OVERVIEW,
        [],
      ),
    ).toEqual({
      kind: "newWorktree",
      projectID: project.id,
      branch: "fix/pty",
      name: "second",
      shareBranch: true,
    });
  });

  test("a refused start yields nothing rather than a request git would refuse", () => {
    expect(
      newSessionIntent(project.id, draft("fix/pty", "checkout"), OVERVIEW, []),
    ).toBeUndefined();
    expect(
      newSessionIntent(project.id, draft("spike/parser", "checkout"), OVERVIEW, []),
    ).toBeUndefined();
  });

  test("the adopted worktree is the one the field named, of several on the branch", () => {
    const shared: BranchOverview = {
      branches: ["fix/pty"],
      worktrees: [
        { directory: WORKTREE, branch: "fix/pty", isMain: false },
        { directory: SECOND, branch: "fix/pty", isMain: false },
      ],
    };
    expect(
      newSessionIntent(project.id, draft("fix/pty", "worktree", { worktree: SECOND }), shared, []),
    ).toEqual({ kind: "adoptWorktree", projectID: project.id, directory: SECOND });
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

// The comboboxes' popups are portalled, so the rows only exist in a browser
// (docs/testing.md, and `bun run check` has no DOM). What the server renders is
// the fields, their values and what each one says it will do — which is the
// half these tests can hold.
describe("the sheet", () => {
  test("a repository opens on its default branch, with both starts offered", () => {
    const markup = render({});
    expect(markup).toContain("No project");
    expect(markup).toContain('value="main"');
    expect(markup).toContain("Check out in the project directory");
    expect(markup).toContain("Use a worktree");
    // The branch field takes a name as well as a pick, and says so.
    expect(markup).toContain("Pick a branch, or type a name to create one.");
    // `main` is checked out in the project directory, which is the first start
    // it permits — so the worktree field is not asked for yet.
    expect(markup).not.toContain("Worktree</label>");
    expect(canCreate(markup)).toBe(true);
  });

  test("a branch its worktree holds opens on that worktree, ready to adopt", () => {
    const held = fakeProject({ directory: REPO, git: { defaultBranch: "fix/pty" } });
    const heldProjects = [held] as const;
    const markup = renderToStaticMarkup(
      <NewSessionSheet
        projects={heldProjects}
        projectID={held.id}
        onProjectChange={noop}
        overview={LOADED}
        sessions={NO_SESSIONS}
        onPickDirectory={noPick}
        onCreate={noop}
        onCancel={noop}
      />,
    );
    expect(markup).toContain(`Checked out in the worktree at ${WORKTREE}.`);
    expect(markup).toContain("Worktree");
    expect(markup).toContain(`Uses the worktree at ${WORKTREE}.`);
    expect(canCreate(markup)).toBe(true);
  });

  test("when every worktree of the branch is open, the field offers a second one", () => {
    const held = fakeProject({ directory: REPO, git: { defaultBranch: "fix/pty" } });
    const heldProjects = [held] as const;
    const openSessions = [fakeSession({ name: "fix/pty", directory: WORKTREE })] as const;
    const markup = renderToStaticMarkup(
      <NewSessionSheet
        projects={heldProjects}
        projectID={held.id}
        onProjectChange={noop}
        overview={LOADED}
        sessions={openSessions}
        onPickDirectory={noPick}
        onCreate={noop}
        onCancel={noop}
      />,
    );
    // The branch's own name, as a new worktree — and the cost of sharing the
    // branch stated where the decision is made.
    expect(markup).toContain('value="fix/pty"');
    expect(markup).toContain("a commit in one moves the other");
    expect(canCreate(markup)).toBe(true);
  });

  test("an empty repository can still be given its first branch", () => {
    const markup = render({
      overview: { kind: "loaded", overview: { branches: [], worktrees: [] } },
    });
    expect(markup).toContain("Branch");
    expect(markup).toContain("The name you type will be the first.");
    // Nothing to check out or adopt yet, so there is nothing to create until
    // the field has a name in it.
    expect(canCreate(markup)).toBe(false);
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
