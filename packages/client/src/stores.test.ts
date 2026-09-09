import { describe, expect, test } from "bun:test";

import type { LaunchProfileID, ProjectID, SessionID, TerminalState } from "@janela/core";

import { createStores } from "./stores.ts";
import {
  fakeLaunchProfile,
  fakeProject,
  fakeSession,
  partial,
  snapshot,
  terminalID,
} from "./test-fakes.ts";

const id = (name: string): SessionID => name as SessionID;
const profileID = (name: string): LaunchProfileID => name as LaunchProfileID;

describe("the mirror", () => {
  test("a full snapshot replaces the world", () => {
    const stores = createStores();

    stores.mirror.apply(snapshot([fakeSession("s1"), fakeSession("s2")]));
    stores.mirror.apply(snapshot([fakeSession("s3")]));

    expect(stores.sessions.sessions.map((session) => session.id)).toEqual([id("s3")]);
  });

  test("a partial update merges by id, keeps order, and appends what is new", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b"), fakeSession("c")]));
    const untouched = stores.sessions.sessions[1];

    const renamedC = { ...fakeSession("c"), name: "c-renamed" };
    const renamedA = { ...fakeSession("a"), name: "a-renamed" };
    stores.mirror.apply(partial([renamedC, renamedA, fakeSession("d")]));

    expect(stores.sessions.sessions.map((session) => session.id)).toEqual([
      id("a"),
      id("b"),
      id("c"),
      id("d"),
    ]);
    expect(stores.sessions.sessions[0]?.name).toBe("a-renamed");
    expect(stores.sessions.sessions[2]?.name).toBe("c-renamed");
    // The same object, not an equal one: a view comparing references re-renders
    // nothing for a session that did not change.
    expect(stores.sessions.sessions[1]).toBe(untouched);
  });

  test("an empty partial collection means unchanged, down to the reference", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a")], [fakeProject("p")]));
    const sessions = stores.sessions.sessions;
    const projects = stores.projects.projects;

    stores.mirror.apply(partial());

    expect(stores.sessions.sessions).toBe(sessions);
    expect(stores.projects.projects).toBe(projects);
  });

  test("projects merge on the same terms", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([], [fakeProject("p1"), fakeProject("p2")]));

    stores.mirror.apply(
      partial([], [{ ...fakeProject("p2"), name: "renamed" }, fakeProject("p3")]),
    );

    expect(stores.projects.projects.map((project) => project.id)).toEqual([
      "p1" as ProjectID,
      "p2" as ProjectID,
      "p3" as ProjectID,
    ]);
    expect(stores.projects.find("p2" as ProjectID)?.name).toBe("renamed");
    expect(stores.projects.find("nope" as ProjectID)).toBeUndefined();
  });

  test("terminal states merge on a partial and are replaced by a snapshot", () => {
    const stores = createStores();
    const [one, two] = [terminalID(), terminalID()];

    stores.mirror.apply(
      snapshot([fakeSession("s1", [one, two])], [], {
        [one]: { kind: "running" },
        [two]: { kind: "idle" },
      }),
    );
    stores.mirror.apply(partial([], [], { [two]: { kind: "exited", code: 0 } }));

    expect(stores.sessions.terminalStates[one]).toEqual({ kind: "running" });
    expect(stores.sessions.terminalStates[two]).toEqual({ kind: "exited", code: 0 });

    // A key absent from a full snapshot is a terminal that no longer exists.
    stores.mirror.apply(snapshot([fakeSession("s1", [one, two])], [], { [two]: { kind: "idle" } }));

    expect(stores.sessions.terminalStates[one]).toBeUndefined();
    expect(stores.sessions.terminalStates[two]).toEqual({ kind: "idle" });
  });

  test("launch profiles merge on a partial and are replaced by a snapshot", () => {
    const stores = createStores();
    const [one, two] = [profileID("p1"), profileID("p2")];

    stores.mirror.apply(snapshot([], [], {}, [fakeLaunchProfile("p1"), fakeLaunchProfile("p2")]));
    const before = stores.sessions.launchProfiles;

    // Empty means unchanged, exactly as the other collections do.
    stores.mirror.apply(partial());
    expect(stores.sessions.launchProfiles).toBe(before);

    stores.mirror.apply(partial([], [], {}, [fakeLaunchProfile("p2", "renamed")]));
    expect(stores.sessions.launchProfiles.map((profile) => profile.id)).toEqual([one, two]);
    expect(stores.sessions.launchProfiles[1]?.name).toBe("renamed");

    // A profile absent from a full snapshot was deleted: keeping it would leave a
    // dead row in the ⌘T picker forever.
    stores.mirror.apply(snapshot([], [], {}, [fakeLaunchProfile("p2")]));
    expect(stores.sessions.launchProfiles.map((profile) => profile.id)).toEqual([two]);
    expect(stores.sessions.launchProfileAvailability).toEqual({ [two]: true });
  });
});

describe("selection", () => {
  test("survives a partial update that does not mention it", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b")]));
    stores.sessions.selection = id("b");

    stores.mirror.apply(partial([{ ...fakeSession("a"), name: "changed" }]));

    expect(stores.sessions.selection).toBe(id("b"));
  });

  test("moves to the next session when a full snapshot proves it gone", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b"), fakeSession("c")]));
    stores.sessions.selection = id("b");

    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("c")]));

    expect(stores.sessions.selection).toBe(id("c"));
  });

  test("falls back to the previous session, then to whatever is left, then to nothing", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b"), fakeSession("c")]));
    stores.sessions.selection = id("c");

    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b")]));
    expect(stores.sessions.selection).toBe(id("b"));

    stores.mirror.apply(snapshot([fakeSession("a")]));
    expect(stores.sessions.selection).toBe(id("a"));

    stores.mirror.apply(snapshot([]));
    expect(stores.sessions.selection).toBeUndefined();
  });

  test("a session that is still there is left selected", () => {
    const stores = createStores();
    stores.mirror.apply(snapshot([fakeSession("a"), fakeSession("b")]));
    stores.sessions.selection = id("a");

    stores.mirror.apply(snapshot([fakeSession("b"), fakeSession("a")]));

    expect(stores.sessions.selection).toBe(id("a"));
  });
});

describe("derived views", () => {
  test("group sessions by project", () => {
    const stores = createStores();
    const project = "p" as ProjectID;
    stores.mirror.apply(
      snapshot(
        [fakeSession("in", [], project), fakeSession("alone"), fakeSession("also", [], project)],
        [fakeProject("p")],
      ),
    );

    expect(stores.sessions.inProject(project).map((session) => session.id)).toEqual([
      id("in"),
      id("also"),
    ]);
    expect(stores.sessions.standaloneSessions.map((session) => session.id)).toEqual([id("alone")]);
  });

  test("a session is running when any terminal is live, and never by inference", () => {
    const stores = createStores();
    const [running, attention, exited] = [terminalID(), terminalID(), terminalID()];
    const states: Record<string, TerminalState> = {
      [running]: { kind: "running" },
      [attention]: { kind: "needsAttention" },
      [exited]: { kind: "exited", code: 0 },
    };

    stores.mirror.apply(
      snapshot(
        [
          fakeSession("live", [exited, running]),
          fakeSession("attention", [attention]),
          fakeSession("dead", [exited]),
          fakeSession("unheard", [terminalID()]),
          fakeSession("empty"),
        ],
        [],
        states,
      ),
    );

    expect(stores.sessions.isRunning(id("live"))).toBe(true);
    expect(stores.sessions.isRunning(id("attention"))).toBe(true);
    expect(stores.sessions.isRunning(id("dead"))).toBe(false);
    expect(stores.sessions.isRunning(id("unheard"))).toBe(false);
    expect(stores.sessions.isRunning(id("empty"))).toBe(false);
    expect(stores.sessions.isRunning(id("absent"))).toBe(false);
  });

  test("hasTerminal answers for every session's terminals", () => {
    const stores = createStores();
    const [mine, theirs, nobodys] = [terminalID(), terminalID(), terminalID()];
    stores.mirror.apply(snapshot([fakeSession("a", [mine]), fakeSession("b", [theirs])]));

    expect(stores.mirror.hasTerminal(mine)).toBe(true);
    expect(stores.mirror.hasTerminal(theirs)).toBe(true);
    expect(stores.mirror.hasTerminal(nobodys)).toBe(false);
  });
});

describe("staleness and notification", () => {
  test("starts stale, a full snapshot clears it, a partial does not", () => {
    const stores = createStores();
    expect(stores.mirror.isStale).toBe(true);

    stores.mirror.apply(partial([fakeSession("a")]));
    expect(stores.mirror.isStale).toBe(true);

    stores.mirror.apply(snapshot([fakeSession("a")]));
    expect(stores.mirror.isStale).toBe(false);

    stores.mirror.markStale();
    expect(stores.mirror.isStale).toBe(true);
    // The mirror is kept, not discarded: this is what the reconnecting strip
    // renders behind.
    expect(stores.sessions.sessions.map((session) => session.id)).toEqual([id("a")]);

    stores.mirror.apply(partial([fakeSession("b")]));
    expect(stores.mirror.isStale).toBe(true);
  });

  test("listeners hear applies, selection changes, and nothing after unsubscribing", () => {
    const stores = createStores();
    let sessions = 0;
    let projects = 0;
    const stop = stores.sessions.subscribe(() => {
      sessions += 1;
    });
    stores.projects.subscribe(() => {
      projects += 1;
    });

    stores.mirror.apply(snapshot([fakeSession("a")]));
    expect(sessions).toBe(1);
    // One apply is one notification for both views: a listener must never see a
    // half-applied update.
    expect(projects).toBe(1);

    stores.sessions.selection = id("a");
    expect(sessions).toBe(2);
    // Setting the same value again changes nothing and says nothing.
    stores.sessions.selection = id("a");
    expect(sessions).toBe(2);

    stores.mirror.markStale();
    expect(sessions).toBe(3);

    stop();
    stores.mirror.apply(snapshot([]));
    expect(sessions).toBe(3);
    expect(projects).toBe(4);
  });
});
