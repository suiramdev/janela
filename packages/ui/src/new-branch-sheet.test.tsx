import { describe, expect, test } from "bun:test";

import type { ProjectID } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { NewBranchSheet, newBranchDraft, preselectedStartPoint } from "./new-branch-sheet.tsx";
import { fakeFolderProject, fakeProject } from "./test-fakes.ts";

const noop = (): void => {};

const repository = fakeProject({ name: "janela", git: { defaultBranch: "trunk" } });
const second = fakeProject({ name: "api", git: { defaultBranch: "develop" } });
const folderOnly = [fakeFolderProject()];
const bothKinds = [fakeFolderProject(), repository];
const onlyRepository = [repository];
const twoRepositories = [repository, second];

describe("preselectedStartPoint", () => {
  test("is the project's default branch, and blank when it has none", () => {
    expect(preselectedStartPoint(repository)).toBe("trunk");
    expect(preselectedStartPoint(undefined)).toBe("");
  });
});

describe("newBranchDraft", () => {
  test("a blank branch cannot be sent, whitespace included", () => {
    expect(newBranchDraft(repository.id, "", "main")).toBeUndefined();
    expect(newBranchDraft(repository.id, "   ", "main")).toBeUndefined();
    expect(newBranchDraft(undefined, "feature/x", "main")).toBeUndefined();
  });

  test("a blank start point is omitted rather than sent empty", () => {
    expect(newBranchDraft(repository.id, " feature/x ", "  ")).toEqual({
      projectID: repository.id,
      branch: "feature/x",
    });
    expect(newBranchDraft(repository.id, "feature/x", " trunk ")).toEqual({
      projectID: repository.id,
      branch: "feature/x",
      startPoint: "trunk",
    });
  });
});

describe("NewBranchSheet markup", () => {
  test("only repositories are offered, with the default branch preselected", () => {
    const markup = renderToStaticMarkup(
      <NewBranchSheet projects={bothKinds} onCreate={noop} onCancel={noop} />,
    );

    expect(markup).toContain("janela");
    expect(markup).not.toContain("notes");
    expect(markup).toContain('value="trunk"');
  });

  test("the session's own project is preselected when it can have worktrees", () => {
    const markup = renderToStaticMarkup(
      <NewBranchSheet
        projects={twoRepositories}
        initialProjectID={second.id}
        onCreate={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain('value="develop"');
  });

  test("a project the sheet cannot use falls back to one it can", () => {
    const markup = renderToStaticMarkup(
      <NewBranchSheet
        projects={onlyRepository}
        initialProjectID={"ghost" as ProjectID}
        onCreate={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain('value="trunk"');
  });

  test("no repository at all says what to do about it", () => {
    const markup = renderToStaticMarkup(
      <NewBranchSheet projects={folderOnly} onCreate={noop} onCancel={noop} />,
    );

    expect(markup).toContain("Add a git repository as a project first.");
  });
});
