import { describe, expect, test } from "bun:test";

import { absolutePath, type ProjectID, type SessionID } from "@janela/core";

import { fakeProject, fakeSession } from "../../../shared/lib/test-fakes/index.ts";
import { type MenuActionRow, type MenuRow, placeRows } from "../../../shared/ui/index.ts";
import {
  type TerminalMenuTarget,
  projectMenuRows,
  sessionMenuRows,
  tabMenuRows,
  terminalMenuRows,
  windowMenuRows,
} from "./menu-rows.ts";
import type { SidebarActions } from "./sidebar-actions.ts";

interface RecordedTabRows {
  readonly rows: readonly MenuRow[];
  readonly calls: string[];
}

const labels = (rows: readonly MenuRow[]): readonly string[] =>
  rows.filter((row): row is MenuActionRow => row.kind === "item").map((row) => row.label);

const row = (rows: readonly MenuRow[], label: string): MenuActionRow => {
  const found = rows.find((candidate): candidate is MenuActionRow => {
    return candidate.kind === "item" && candidate.label === label;
  });

  if (found === undefined) throw new Error(`no row labelled ${label}: ${labels(rows).join(", ")}`);

  return found;
};

function recordingActions(): SidebarActions & { readonly calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    newSession: (id: ProjectID) => calls.push(`newSession:${id}`),
    newTerminal: (id: SessionID) => calls.push(`newTerminal:${id}`),
    openProjectSettings: (id: ProjectID) => calls.push(`openProjectSettings:${id}`),
    removeProject: (project) => calls.push(`removeProject:${project.id}`),
    removeSession: (session) => calls.push(`removeSession:${session.id}`),
    revealInFinder: (path) => calls.push(`revealInFinder:${path}`),
    openInTerminal: (path) => calls.push(`openInTerminal:${path}`),
  };
}

function terminalTarget(hasSelection: boolean, calls: string[]): TerminalMenuTarget {
  return {
    hasSelection,
    copy: () => calls.push("copy"),
    paste: () => calls.push("paste"),
    clear: () => calls.push("clear"),
    splitRight: () => calls.push("splitRight"),
    splitDown: () => calls.push("splitDown"),
    newTerminal: () => calls.push("newTerminal"),
    close: () => calls.push("close"),
  };
}

function keys(rows: readonly MenuRow[]): readonly string[] {
  return placeRows(rows).map((placed) => placed.key);
}

function tabRows(index: number, tabCount: number): RecordedTabRows {
  const calls: string[] = [];

  const rows = tabMenuRows({
    newTerminal: () => calls.push("newTerminal"),
    splitRight: () => calls.push("splitRight"),
    splitDown: () => calls.push("splitDown"),
    close: (scope) => calls.push(`close:${scope}`),
    index,
    tabCount,
  });

  return { rows, calls };
}

describe("projectMenuRows", () => {
  const project = fakeProject({ name: "janela", directory: absolutePath("/src/janela") });

  test("every row acts on the project it was opened over, not on the selection", () => {
    const actions = recordingActions();
    const rows = projectMenuRows(project, actions);

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(actions.calls).toEqual([
      `newSession:${project.id}`,
      "revealInFinder:/src/janela",
      "openInTerminal:/src/janela",
      `openProjectSettings:${project.id}`,
      `removeProject:${project.id}`,
    ]);
  });

  test("a folder that is not a repository offers the same rows", () => {
    const { git: _git, ...plain } = fakeProject({ name: "notes" });

    expect(labels(projectMenuRows(plain, recordingActions()))).toEqual(
      labels(projectMenuRows(project, recordingActions())),
    );
  });

  test("removing is the only destructive row, and it is last", () => {
    const rows = projectMenuRows(project, recordingActions());
    const destructive = rows.filter((entry) => entry.kind === "item" && entry.destructive === true);

    expect(destructive).toHaveLength(1);
    expect(labels(rows).at(-1)).toBe("Remove Project…");
  });
});

describe("sessionMenuRows", () => {
  test("the rows name the session, and removing it is destructive", () => {
    const session = fakeSession({ name: "fix/pty", directory: absolutePath("/src/janela-pty") });
    const actions = recordingActions();
    const rows = sessionMenuRows(session, actions);

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(actions.calls).toEqual([
      `newTerminal:${session.id}`,
      "revealInFinder:/src/janela-pty",
      "openInTerminal:/src/janela-pty",
      `removeSession:${session.id}`,
    ]);
    expect(row(rows, "Remove Session…").destructive).toBe(true);
  });
});

describe("terminalMenuRows", () => {
  test("Copy is offered only when there is something to copy", () => {
    const withSelection = terminalMenuRows(terminalTarget(true, []));
    const without = terminalMenuRows(terminalTarget(false, []));

    expect(labels(withSelection)).toEqual(labels(without));
    expect(row(withSelection, "Copy").disabled).toBe(false);
    expect(row(without, "Copy").disabled).toBe(true);
    expect(row(without, "Paste").disabled).toBeUndefined();
  });

  test("every row is wired to the terminal it was opened over", () => {
    const calls: string[] = [];
    const rows = terminalMenuRows(terminalTarget(true, calls));

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(calls).toEqual([
      "copy",
      "paste",
      "splitRight",
      "splitDown",
      "newTerminal",
      "clear",
      "close",
    ]);
  });

  test("closing a terminal is destructive and never disabled", () => {
    const rows = terminalMenuRows(terminalTarget(false, []));

    expect(row(rows, "Close Terminal").destructive).toBe(true);
    expect(row(rows, "Close Terminal").disabled).toBeUndefined();
  });
});

describe("tabMenuRows and windowMenuRows", () => {
  test("a tab's rows act on that tab", () => {
    const { rows, calls } = tabRows(1, 3);

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(calls).toEqual([
      "newTerminal",
      "splitRight",
      "splitDown",
      "close:this",
      "close:others",
      "close:left",
      "close:right",
      "close:all",
    ]);
  });

  test("every close is destructive: ending more must not look safer", () => {
    const { rows } = tabRows(1, 3);

    for (const closing of labels(rows).filter((each) => each.startsWith("Close"))) {
      expect(row(rows, closing).destructive).toBe(true);
    }
  });

  test("a middle tab of three can close either side, and the rest", () => {
    const { rows } = tabRows(1, 3);

    expect(row(rows, "Close Other Tabs").disabled).toBe(false);
    expect(row(rows, "Close Tabs to the Left").disabled).toBe(false);
    expect(row(rows, "Close Tabs to the Right").disabled).toBe(false);
  });

  test("a scope with nothing in it is dimmed, not missing", () => {
    const first = tabRows(0, 2).rows;
    const last = tabRows(1, 2).rows;
    const only = tabRows(0, 1).rows;

    expect(row(first, "Close Tabs to the Left").disabled).toBe(true);
    expect(row(first, "Close Tabs to the Right").disabled).toBe(false);
    expect(row(last, "Close Tabs to the Right").disabled).toBe(true);
    expect(row(only, "Close Other Tabs").disabled).toBe(true);
    expect(row(only, "Close All Tabs").disabled).toBeUndefined();
    expect(labels(only)).toEqual(labels(last));
  });

  test("the window's menu dispatches commands, and only the three that start something", () => {
    const dispatched: string[] = [];
    const rows = windowMenuRows((id) => dispatched.push(id));

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(dispatched).toEqual(["newSession", "addProject", "showCommands"]);
  });
});

describe("placeRows", () => {
  test("the numbers count selectable rows, so a label or separator takes none", () => {
    const rows: readonly MenuRow[] = [
      { kind: "label", label: "janela" },
      { kind: "item", label: "New Session…", onSelect: () => {} },
      { kind: "separator" },
      { kind: "item", label: "Remove…", onSelect: () => {}, destructive: true },
    ];

    expect(placeRows(rows).map((placed) => placed.index)).toEqual([-1, 0, -1, 1]);
  });

  test("keys come from the labels, not from the position", () => {
    const withCopy: readonly MenuRow[] = [
      { kind: "item", label: "Copy", onSelect: () => {} },
      { kind: "separator" },
      { kind: "item", label: "Clear", onSelect: () => {} },
    ];

    const withoutCopy = withCopy.slice(1);

    expect(keys(withCopy)).toEqual(["item:Copy", "separator:item:Copy", "item:Clear"]);
    expect(keys(withoutCopy).at(-1)).toBe("item:Clear");
  });
});
