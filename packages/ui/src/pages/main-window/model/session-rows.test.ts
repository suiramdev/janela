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
import { sessionStatus, sidebarRows } from "./session-rows.ts";

describe("sessionStatus", () => {
  const withTerminals = session("s", { terminals: [terminal("a"), terminal("b")] });

  test("attention wins over everything", () => {
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "running" },
        [terminalID("b")]: { kind: "needsAttention" },
      }),
    ).toBe("attention");
  });

  test("running wins over a failure", () => {
    expect(
      sessionStatus(withTerminals, {
        [terminalID("a")]: { kind: "exited", code: 1 },
        [terminalID("b")]: { kind: "running" },
      }),
    ).toBe("running");
  });

  test("a non-zero exit is a failure and a zero exit is not", () => {
    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "exited", code: 130 } })).toBe(
      "failed",
    );
    expect(sessionStatus(withTerminals, { [terminalID("a")]: { kind: "exited", code: 0 } })).toBe(
      "idle",
    );
  });

  test("a failed spawn is a failure", () => {
    expect(
      sessionStatus(withTerminals, { [terminalID("a")]: { kind: "failed", message: "no such" } }),
    ).toBe("failed");
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

describe("sidebarRows", () => {
  const standalone = session("loose");
  const inside = session("member", { project: "p" });
  const expanded = project("p", true);
  const collapsed = project("p", false);
  const empty = new Map<ProjectID, boolean>();

  test("standalone sessions come before every project", () => {
    const rows = sidebarRows([expanded], [inside, standalone], NO_STATES, empty);

    expect(
      rows.map((row) => (row.kind === "project" ? `project:${row.project.id}` : row.session.id)),
    ).toEqual([sessionID("loose"), "project:p", sessionID("member")]);
  });

  test("a collapsed project hides its sessions", () => {
    const rows = sidebarRows([collapsed], [inside], NO_STATES, empty);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("project");
  });

  test("a local override beats Project.isExpanded, both ways", () => {
    const opened = sidebarRows([collapsed], [inside], NO_STATES, new Map([[projectID("p"), true]]));
    const closed = sidebarRows([expanded], [inside], NO_STATES, new Map([[projectID("p"), false]]));

    expect(opened).toHaveLength(2);
    expect(closed).toHaveLength(1);
  });

  test("project sessions are indented and standalone ones are not", () => {
    const rows = sidebarRows([expanded], [inside, standalone], NO_STATES, empty);
    const indents = rows.flatMap((row) => (row.kind === "session" ? [row.indented] : []));

    expect(indents).toEqual([false, true]);
  });

  test("status travels with the row", () => {
    const rows = sidebarRows([], [standalone], { [terminalID("x")]: { kind: "running" } }, empty);

    expect(rows[0]?.kind === "session" && rows[0].status).toBe("idle");
  });
});
