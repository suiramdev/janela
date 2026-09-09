import { describe, expect, test } from "bun:test";

import { instant, type Project, type Session, type SessionID } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { JumpList, rankedSessions } from "./jump-list.tsx";
import { fakeProject, fakeSession, fakeTerminal } from "./test-fakes.ts";

const at = (minute: number): Session["lastActiveAt"] =>
  instant(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`);

const janela = fakeProject({ name: "janela" });
const other = fakeProject({ name: "other" });

const loose = fakeSession({ name: "notes", terminals: [fakeTerminal()] });
const inside = fakeSession({ name: "main", projectID: janela.id });
const ONE_PROJECT = [janela];
const TWO_SESSIONS = [loose, inside];

const NO_STATES = {};
const NO_PROJECTS: readonly Project[] = [];
const NO_SESSIONS: readonly Session[] = [];
const noop = (): void => {};

describe("rankedSessions", () => {
  test("an empty query lists by recency, with the current session last", () => {
    const oldest = fakeSession({ name: "oldest", lastActiveAt: at(1) });
    const newest = fakeSession({ name: "newest", lastActiveAt: at(3) });
    const middle = fakeSession({ name: "middle", lastActiveAt: at(2) });

    const ranked = rankedSessions("", [], [oldest, newest, middle], newest.id);

    // Enter on an untouched jump list goes to the most recent *other* session:
    // "back" is what a two-session workflow means by it.
    expect(ranked.map((session) => session.name)).toEqual(["middle", "oldest", "newest"]);
  });

  test("the project name is part of the haystack, so two same-named sessions differ", () => {
    const mine = fakeSession({ name: "fix/pty", projectID: janela.id, lastActiveAt: at(1) });
    const theirs = fakeSession({ name: "fix/pty", projectID: other.id, lastActiveAt: at(2) });

    const ranked = rankedSessions("jan pt", [janela, other], [theirs, mine], undefined);

    expect(ranked[0]?.id).toBe(mine.id);
  });

  test("a query that matches nothing returns nothing", () => {
    const sessions = Array.from({ length: 40 }, (_, index) =>
      fakeSession({ name: `session-${index}`, lastActiveAt: at(1) }),
    );
    expect(rankedSessions("zzz", [], sessions, undefined)).toHaveLength(0);
    expect(rankedSessions("s1", [], sessions, undefined).length).toBeGreaterThan(0);
  });
});

describe("JumpList markup", () => {
  test("each row names its project, or says the session is standalone", () => {
    const markup = renderToStaticMarkup(
      <JumpList
        projects={ONE_PROJECT}
        sessions={TWO_SESSIONS}
        terminalStates={NO_STATES}
        currentSelection={undefined}
        onPick={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain("Standalone");
    expect(markup).toContain("janela");
    expect(markup).toContain("notes");
  });

  test("no sessions at all says so rather than showing an empty box", () => {
    const markup = renderToStaticMarkup(
      <JumpList
        projects={NO_PROJECTS}
        sessions={NO_SESSIONS}
        terminalStates={NO_STATES}
        currentSelection={"nope" as SessionID}
        onPick={noop}
        onCancel={noop}
      />,
    );

    expect(markup).toContain("No sessions yet.");
  });
});
