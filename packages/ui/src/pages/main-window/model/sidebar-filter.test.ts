import { describe, expect, test } from "bun:test";

import type { ProjectID, SessionID, TerminalID, TerminalState } from "@janela/core";

import {
  fakeFolderProject,
  fakeProject,
  fakeSession,
  fakeTerminal,
  states,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  SESSION_FILTERS,
  SESSION_FILTER_TITLE,
  filterSidebar,
  mergedExpansions,
} from "./sidebar-filter.ts";

const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = {};

const projectID = (raw: string): ProjectID => raw as ProjectID;

const sessionID = (raw: string): SessionID => raw as SessionID;

const terminalID = (raw: string): TerminalID => raw as TerminalID;

const janela = fakeProject({ id: projectID("p-janela"), name: "janela" });

const api = fakeFolderProject({ id: projectID("p-api"), name: "api" });

const PROJECTS = [janela, api];

const main = fakeSession({ id: sessionID("s-main"), name: "main", projectID: janela.id });

const pty = fakeSession({ id: sessionID("s-pty"), name: "fix/pty", projectID: janela.id });

const deploy = fakeSession({ id: sessionID("s-deploy"), name: "deploy", projectID: api.id });

const scratch = fakeSession({ id: sessionID("s-scratch"), name: "scratch" });

const SESSIONS = [scratch, main, pty, deploy];

const running = fakeSession({
  id: sessionID("s-run"),
  name: "run",
  projectID: api.id,
  terminals: [fakeTerminal({ id: terminalID("t-run") })],
});

const RUNNING_STATES = states([
  terminalID("t-run"),
  { kind: "running", activity: { kind: "working" } },
]);

describe("SESSION_FILTERS", () => {
  test("the menu offers every filter that has a title, each exactly once", () => {
    expect(Object.keys(SESSION_FILTER_TITLE).toSorted()).toEqual(SESSION_FILTERS.toSorted());
  });
});

describe("filterSidebar", () => {
  test("`all` returns the very same arrays", () => {
    const result = filterSidebar("all", PROJECTS, SESSIONS, NO_STATES);

    expect(result.projects).toBe(PROJECTS);
    expect(result.sessions).toBe(SESSIONS);
    expect(result.expansions.size).toBe(0);
  });

  test("a status filter keeps only the sessions in that state", () => {
    const result = filterSidebar("running", PROJECTS, [main, running], RUNNING_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual(["run"]);
  });

  test("a status filter drops projects with nothing left in them", () => {
    const result = filterSidebar("running", PROJECTS, [main, running], RUNNING_STATES);

    expect(result.projects.map((project) => project.id)).toEqual([api.id]);
  });

  test("a standalone session survives on its own status, with no project to drag in", () => {
    const result = filterSidebar("idle", PROJECTS, [scratch], NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual(["scratch"]);
    expect(result.projects).toEqual([]);
  });

  test("filtering does not reorder: the row under the cursor stays put", () => {
    const result = filterSidebar("idle", PROJECTS, SESSIONS, NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual([
      "scratch",
      "main",
      "fix/pty",
      "deploy",
    ]);
  });

  test("a narrowed list expands the projects it kept something inside", () => {
    const result = filterSidebar("running", PROJECTS, [main, running], RUNNING_STATES);

    expect(result.expansions.get(api.id)).toBe(true);
    expect(result.expansions.has(janela.id)).toBe(false);
  });
});

describe("mergedExpansions", () => {
  const collapsed: ReadonlyMap<ProjectID, boolean> = new Map([[janela.id, false]]);

  test("the filter wins over what the user last collapsed", () => {
    const merged = mergedExpansions(collapsed, new Map([[janela.id, true]]));

    expect(merged.get(janela.id)).toBe(true);
  });

  test("no forced expansions leaves the user's overrides untouched", () => {
    expect(mergedExpansions(collapsed, new Map())).toBe(collapsed);
  });
});
