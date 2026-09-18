import { describe, expect, test } from "bun:test";

import type { Project } from "@janela/core";

import { fakeFolderProject, fakeProject } from "../../../shared/lib/test-fakes/index.ts";
import {
  SETTINGS_TAB_INFO,
  projectSections,
  routeKey,
  sectionElementID,
  settingsMatches,
} from "./settings-index.ts";

const JANELA = fakeProject({ name: "janela" });

const NOTES = fakeFolderProject({ name: "notes" });

const PROJECTS: readonly Project[] = [JANELA, NOTES];

const titles = (query: string, projects: readonly Project[] = PROJECTS): readonly string[] =>
  settingsMatches(query, projects).map((match) => routeKey(match.route));

describe("the index", () => {
  test("gives every section a unique anchor", () => {
    const anchors = [
      ...SETTINGS_TAB_INFO.flatMap((info) => info.sections),
      ...projectSections(JANELA),
    ].map((section) => sectionElementID(section.id));

    expect(new Set(anchors).size).toBe(anchors.length);
  });

  test("offers a folder project no worktree section", () => {
    expect(projectSections(NOTES).map((section) => section.id)).not.toContain("projectWorktrees");
    expect(projectSections(JANELA).map((section) => section.id)).toContain("projectWorktrees");
  });

  test("the Integrations tab lists the hooks and nothing else", () => {
    const integrations = SETTINGS_TAB_INFO.find((info) => info.id === "integrations");

    expect(integrations?.sections.map((section) => section.id)).toEqual(["integrationsHooks"]);
  });
});

describe("searching", () => {
  test("an empty query is not a search", () => {
    expect(settingsMatches("", PROJECTS)).toEqual([]);
    expect(settingsMatches("   ", PROJECTS)).toEqual([]);
  });

  test("finds a field by its label, and says which one matched", () => {
    const [first] = settingsMatches("font size", PROJECTS);

    expect(first?.route).toEqual({ kind: "tab", tab: "appearance" });
    expect(first?.section).toBe("appearanceFont");
    expect(first?.detail).toBe("Font size");
  });

  test("finds a pane by a word it never displays", () => {
    const [first] = settingsMatches("janelad", PROJECTS);

    expect(first?.route).toEqual({ kind: "tab", tab: "permissions" });
  });

  test("names a section rather than the keyword that matched", () => {
    const [first] = settingsMatches("unregister", PROJECTS);

    expect(first?.detail).toBe("Stopping it");
  });

  test("offers one row per pane, so a pane cannot fill the list", () => {
    const matches = settingsMatches("a", PROJECTS);
    const keys = matches.map((match) => routeKey(match.route));

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("finds every project that has the same setting", () => {
    expect(titles("automation")).toEqual([`project-${JANELA.id}`, `project-${NOTES.id}`]);
  });

  test("ranks a project named by the query first", () => {
    expect(titles("notes")[0]).toBe(`project-${NOTES.id}`);
  });

  test("matches nothing rather than everything when nothing matches", () => {
    expect(settingsMatches("qqzz", PROJECTS)).toEqual([]);
  });

  test("does not offer a project's worktree setting when it has none", () => {
    const matches = settingsMatches("worktree directory", [NOTES]);

    expect(matches).toEqual([]);
  });
});
