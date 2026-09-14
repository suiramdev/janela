import { describe, expect, test } from "bun:test";

import type { ProjectID, SessionID, TerminalID, TerminalState } from "@janela/core";

import {
  EVERYTHING,
  filterSidebar,
  isNarrowed,
  mergedExpansions,
  type SidebarQuery,
} from "./sidebar-filter.ts";
import { fakeFolderProject, fakeProject, fakeSession, fakeTerminal, states } from "./test-fakes.ts";

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

const query = (overrides: Partial<SidebarQuery> = {}): SidebarQuery => ({
  ...EVERYTHING,
  ...overrides,
});

describe("isNarrowed", () => {
  test("whitespace is not a search", () => {
    expect(isNarrowed(query({ text: "   " }))).toBe(false);
    expect(isNarrowed(query({ text: " a " }))).toBe(true);
  });

  test("a status filter narrows even with an empty field", () => {
    expect(isNarrowed(query({ filter: "running" }))).toBe(true);
    expect(isNarrowed(EVERYTHING)).toBe(false);
  });
});

describe("filterSidebar", () => {
  test("an unnarrowed query returns the very same arrays", () => {
    const result = filterSidebar(EVERYTHING, PROJECTS, SESSIONS, NO_STATES);

    // Identity, not equality: this is the state the sidebar spends its life in,
    // and copying both lists on every keystroke-free render would be waste.
    expect(result.projects).toBe(PROJECTS);
    expect(result.sessions).toBe(SESSIONS);
    expect(result.expansions.size).toBe(0);
  });

  test("a project whose own name matches keeps all of its sessions", () => {
    const result = filterSidebar(query({ text: "janela" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.projects.map((project) => project.id)).toEqual([janela.id]);
    // `main` does not contain "janela" anywhere. It is here because its project is.
    expect(result.sessions.map((session) => session.name)).toEqual(["main", "fix/pty"]);
  });

  test("a session matches on its own name, and drags its project in with it", () => {
    const result = filterSidebar(query({ text: "deploy" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual(["deploy"]);
    expect(result.projects.map((project) => project.id)).toEqual([api.id]);
  });

  test("the matcher is the same subsequence one the jump list uses", () => {
    const result = filterSidebar(query({ text: "fpty" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual(["fix/pty"]);
  });

  test("a standalone session has no project to inherit a match from", () => {
    const result = filterSidebar(query({ text: "scratch" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual(["scratch"]);
    expect(result.projects).toEqual([]);
  });

  test("matching does not reorder: the row under the cursor stays put", () => {
    // `a` scores differently on each of these, and hits `janela` too — so
    // `fix/pty` is here by rule 1, with no `a` in it at all. The order is still
    // the input order, because this list is pointed at rather than read.
    const result = filterSidebar(query({ text: "a" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.sessions.map((session) => session.name)).toEqual([
      "scratch",
      "main",
      "fix/pty",
      "deploy",
    ]);
  });

  test("a status filter drops projects with nothing left in them", () => {
    const running = fakeSession({
      id: sessionID("s-run"),
      name: "run",
      projectID: api.id,
      terminals: [fakeTerminal({ id: terminalID("t-run") })],
    });

    const result = filterSidebar(
      query({ filter: "running" }),
      PROJECTS,
      [main, running],
      states([terminalID("t-run"), { kind: "running" }]),
    );

    expect(result.sessions.map((session) => session.name)).toEqual(["run"]);
    // `janela` had one session and it was idle: with "running" on, a project
    // with nothing running is exactly what the filter was asked to hide.
    expect(result.projects.map((project) => project.id)).toEqual([api.id]);
  });

  test("a narrowed query expands the projects it matched inside", () => {
    const result = filterSidebar(query({ text: "deploy" }), PROJECTS, SESSIONS, NO_STATES);

    expect(result.expansions.get(api.id)).toBe(true);
    expect(result.expansions.has(janela.id)).toBe(false);
  });
});

describe("mergedExpansions", () => {
  const collapsed: ReadonlyMap<ProjectID, boolean> = new Map([[janela.id, false]]);

  test("the query wins over what the user last collapsed", () => {
    const merged = mergedExpansions(collapsed, new Map([[janela.id, true]]));

    expect(merged.get(janela.id)).toBe(true);
  });

  test("no forced expansions leaves the user's overrides untouched", () => {
    expect(mergedExpansions(collapsed, new Map())).toBe(collapsed);
  });
});
