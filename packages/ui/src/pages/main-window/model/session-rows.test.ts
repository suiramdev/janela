import { describe, expect, test } from "bun:test";

import type { ProjectID } from "@janela/core";

import {
  NO_STATES,
  project,
  projectID,
  session,
  sessionID,
  terminal,
  terminalID,
} from "./session-fixture.ts";
import { sessionMark, sessionStatus, sidebarRows } from "./session-rows.ts";

describe("sessionStatus", () => {
  const withTerminals = session("s", { terminals: [terminal("a"), terminal("b")] });

  const WORKING = { kind: "running", activity: { kind: "working" } } as const;

  const FINISHED_UNSEEN = {
    kind: "needsAttention",
    activity: { kind: "finished", outcome: "completed" },
  } as const;

  const FINISHED_SEEN = {
    kind: "running",
    activity: { kind: "finished", outcome: "completed" },
  } as const;

  const STOPPED = {
    kind: "needsAttention",
    activity: { kind: "finished", outcome: "failed" },
  } as const;

  test("an agent reporting work is running, with or without a progress bar", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: WORKING })).toBe("running");
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "running", progress: { kind: "indeterminate" } },
      }),
    ).toBe("running");
  });

  test("a live shell with nothing to report is idle, not running", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "running" } })).toBe("idle");
  });

  test("a finished agent is unread until the user looks, then nothing", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: FINISHED_UNSEEN })).toBe("unread");
    expect(sessionStatus(withTerminals, { [terminalID("a")]: FINISHED_SEEN })).toBe("idle");
  });

  test("an agent waiting on the user is unread until the daemon lowers the flag", () => {
    for (const need of ["permission", "input"] as const) {
      const activity = { kind: "waiting", need } as const;

      expect(
        sessionStatus(withTerminals, { [terminalID("a")]: { kind: "needsAttention", activity } }),
      ).toBe("unread");

      expect(
        sessionStatus(withTerminals, { [terminalID("a")]: { kind: "running", activity } }),
      ).toBe("idle");
    }
  });

  test("a bell nobody has looked at is unread", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "needsAttention" } })).toBe(
      "unread",
    );
  });

  test("a bell in a working agent is still running", () => {
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "needsAttention", activity: { kind: "working" } },
      }),
    ).toBe("running");
  });

  test("an agent that stopped with an error is an error, looked at or not", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: STOPPED })).toBe("error");
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "running", activity: { kind: "finished", outcome: "failed" } },
      }),
    ).toBe("error");
  });

  test("a non-zero exit or a failed spawn is an error, and a zero exit is nothing", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "exited", code: 130 } })).toBe(
      "error",
    );

    expect(
      sessionStatus(withTerminals, { [terminalID("a")]: { kind: "failed", message: "no such" } }),
    ).toBe("error");

    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "exited", code: 0 } })).toBe(
      "idle",
    );
  });

  test("the session runs while any harness runs, whatever the others finished", () => {
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: WORKING,
        [terminalID("b")]: FINISHED_UNSEEN,
      }),
    ).toBe("running");

    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: WORKING,
        [terminalID("b")]: { kind: "needsAttention", activity: { kind: "waiting", need: "input" } },
      }),
    ).toBe("running");
  });

  test("the session is unread only once every harness has stopped", () => {
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: FINISHED_UNSEEN,
        [terminalID("b")]: FINISHED_SEEN,
      }),
    ).toBe("unread");

    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: FINISHED_UNSEEN,
        [terminalID("b")]: { kind: "running" },
      }),
    ).toBe("unread");
  });

  test("an error is never hidden by a sibling that runs or waits", () => {
    expect(
      sessionStatus(withTerminals, { [terminalID("a")]: WORKING, [terminalID("b")]: STOPPED }),
    ).toBe("error");

    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "exited", code: 1 },
        [terminalID("b")]: FINISHED_UNSEEN,
      }),
    ).toBe("error");
  });

  test("a terminal the daemon has not reported counts as nothing", () => {
    expect(sessionStatus(withTerminals, NO_STATES)).toBe("idle");
  });

  test("states for terminals this session does not own are ignored", () => {
    expect(sessionStatus(withTerminals, { [terminalID("z")]: { kind: "needsAttention" } })).toBe(
      "idle",
    );
  });
});

describe("sessionMark", () => {
  const withTerminals = session("s", { terminals: [terminal("a"), terminal("b")] });

  test("an unread session can be marked read", () => {
    expect(sessionMark(withTerminals, { [terminalID("a")]: { kind: "needsAttention" } })).toBe(
      "read",
    );
  });

  test("a quiet session with a live terminal can be marked unread", () => {
    expect(sessionMark(withTerminals, { [terminalID("a")]: { kind: "running" } })).toBe("unread");
    expect(
      sessionMark(withTerminals, {
        [terminalID("a")]: { kind: "exited", code: 0 },
        [terminalID("b")]: {
          kind: "running",
          activity: { kind: "finished", outcome: "completed" },
        },
      }),
    ).toBe("unread");
  });

  test("a session with nothing live, or one running or errored, takes no mark", () => {
    expect(sessionMark(withTerminals, NO_STATES)).toBe("none");
    expect(sessionMark(withTerminals, { [terminalID("a")]: { kind: "exited", code: 0 } })).toBe(
      "none",
    );

    expect(
      sessionMark(withTerminals, {
        [terminalID("a")]: { kind: "running", activity: { kind: "working" } },
      }),
    ).toBe("none");

    expect(sessionMark(withTerminals, { [terminalID("a")]: { kind: "exited", code: 1 } })).toBe(
      "none",
    );
  });
});

describe("sidebarRows", () => {
  const standalone = session("loose");
  const inside = session("member", { project: "p" });
  const expanded = project("p", true);
  const collapsed = project("p", false);
  const empty = new Map<ProjectID, boolean>();

  test("standalone sessions come before every project, and a project owns its sessions", () => {
    const rows = sidebarRows([expanded], [inside, standalone], NO_STATES, empty);

    expect(
      rows.map((row) =>
        row.kind === "project"
          ? `project:${row.project.id}:${row.sessions.map((entry) => entry.session.id).join(",")}`
          : row.session.id,
      ),
    ).toEqual([sessionID("loose"), `project:p:${sessionID("member")}`]);
  });

  test("a collapsed project keeps its sessions, closed", () => {
    const rows = sidebarRows([collapsed], [inside], NO_STATES, empty);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "project" && rows[0].isExpanded).toBe(false);
    expect(rows[0]?.kind === "project" && rows[0].sessions).toHaveLength(1);
  });

  test("a local override beats Project.isExpanded, both ways", () => {
    const opened = sidebarRows([collapsed], [inside], NO_STATES, new Map([[projectID("p"), true]]));
    const closed = sidebarRows([expanded], [inside], NO_STATES, new Map([[projectID("p"), false]]));

    expect(opened[0]?.kind === "project" && opened[0].isExpanded).toBe(true);
    expect(closed[0]?.kind === "project" && closed[0].isExpanded).toBe(false);
  });

  test("status and mark travel with the row, nested or not", () => {
    const states = { [terminalID("x")]: { kind: "needsAttention" } } as const;
    const loose = session("loose", { terminals: [terminal("x")] });
    const member = session("member", { project: "p", terminals: [terminal("x")] });
    const rows = sidebarRows([expanded], [loose, member], states, empty);

    expect(rows[0]?.kind === "session" && [rows[0].status, rows[0].mark]).toEqual([
      "unread",
      "read",
    ]);

    expect(
      rows[1]?.kind === "project" && rows[1].sessions.map((entry) => [entry.status, entry.mark]),
    ).toEqual([["unread", "read"]]);
  });
});
