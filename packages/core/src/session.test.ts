import { describe, expect, test } from "bun:test";

import type { AbsolutePath, ProjectID, SessionID } from "./identifiers.ts";
import { emptyLayout } from "./session-layout.ts";
import type { Backing, Session, WorktreeBinding } from "./session.ts";
import { backingViolations, isStandalone, ownsItsDirectory } from "./session.ts";

const directory = "/Users/x/code/janela" as AbsolutePath;
const project = "1c8c9c8e-0e1a-4f2c-9a10-6c1c1f0b9f11" as ProjectID;

const binding: WorktreeBinding = {
  path: directory,
  ownership: "managed",
  includedPaths: [],
};

const session = (backing: Backing, projectID: ProjectID | undefined = undefined): Session => {
  const base: Session = {
    id: "0f6e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b" as SessionID,
    name: "feature",
    directory,
    backing,
    terminals: [],
    layout: emptyLayout,
    accent: "none",
    createdAt: "2026-01-02T03:04:05.000Z" as Session["createdAt"],
    lastActiveAt: "2026-01-02T03:04:05.000Z" as Session["lastActiveAt"],
    isPinned: false,
  };

  return projectID === undefined ? base : { ...base, projectID };
};

describe("backingViolations", () => {
  test("a folder session with no project is fine", () => {
    expect(backingViolations(session({ kind: "folder" }))).toEqual([]);
  });

  test("a folder session inside a project is refused", () => {
    expect(backingViolations(session({ kind: "folder" }, project))).toEqual([
      "folder backing must not belong to a project",
    ]);
  });

  test("a projectDirectory session with a project is fine", () => {
    expect(backingViolations(session({ kind: "projectDirectory" }, project))).toEqual([]);
  });

  test("a projectDirectory session with no project is refused", () => {
    expect(backingViolations(session({ kind: "projectDirectory" }))).toEqual([
      "projectDirectory backing requires a project",
    ]);
  });

  test("a worktree session with a project is fine", () => {
    expect(backingViolations(session({ kind: "worktree", binding }, project))).toEqual([]);
  });

  test("a worktree session with no project is refused", () => {
    expect(backingViolations(session({ kind: "worktree", binding }))).toEqual([
      "worktree backing requires a project",
    ]);
  });

  test("a binding path that drifted from the directory is to re-resolve, not a violation", () => {
    const moved = session(
      { kind: "worktree", binding: { ...binding, path: "/elsewhere" as AbsolutePath } },
      project,
    );

    expect(backingViolations(moved)).toEqual([]);
  });
});

describe("ownsItsDirectory", () => {
  test("a managed worktree is ours to delete", () => {
    expect(ownsItsDirectory(session({ kind: "worktree", binding }, project))).toBe(true);
  });

  test("an adopted worktree existed before us and is not", () => {
    const adopted = session(
      { kind: "worktree", binding: { ...binding, ownership: "adopted" } },
      project,
    );

    expect(ownsItsDirectory(adopted)).toBe(false);
  });

  test("a project directory is the user's checkout", () => {
    expect(ownsItsDirectory(session({ kind: "projectDirectory" }, project))).toBe(false);
  });

  test("a folder the user picked is not ours either", () => {
    expect(ownsItsDirectory(session({ kind: "folder" }))).toBe(false);
  });
});

describe("isStandalone", () => {
  test("true when there is no project", () => {
    expect(isStandalone(session({ kind: "folder" }))).toBe(true);
  });

  test("false when there is one", () => {
    expect(isStandalone(session({ kind: "projectDirectory" }, project))).toBe(false);
  });
});
