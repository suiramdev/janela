import { describe, expect, test } from "bun:test";

import { absolutePath, type ProjectID, type SessionID } from "@janela/core";

import { placeRows, type MenuActionRow, type MenuRow } from "./context-menu-region.tsx";
import {
  projectMenuRows,
  sessionMenuRows,
  tabMenuRows,
  terminalMenuRows,
  windowMenuRows,
  type TerminalMenuTarget,
} from "./menu-rows.ts";
import type { SidebarActions } from "./sidebar-actions.ts";
import { fakeProject, fakeSession } from "./test-fakes.ts";

const labels = (rows: readonly MenuRow[]): readonly string[] =>
  rows.filter((row): row is MenuActionRow => row.kind === "item").map((row) => row.label);

const row = (rows: readonly MenuRow[], label: string): MenuActionRow => {
  const found = rows.find((candidate): candidate is MenuActionRow => {
    return candidate.kind === "item" && candidate.label === label;
  });
  if (found === undefined) throw new Error(`no row labelled ${label}: ${labels(rows).join(", ")}`);
  return found;
};

/** A `SidebarActions` that records the call and its subject. */
function recordingActions(): SidebarActions & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    newSession: (id: ProjectID) => calls.push(`newSession:${id}`),
    newBranchSession: (id: ProjectID) => calls.push(`newBranchSession:${id}`),
    newTerminal: (id: SessionID) => calls.push(`newTerminal:${id}`),
    openProjectSettings: (id: ProjectID) => calls.push(`openProjectSettings:${id}`),
    removeProject: (project) => calls.push(`removeProject:${project.id}`),
    removeSession: (session) => calls.push(`removeSession:${session.id}`),
    revealInFinder: (path) => calls.push(`revealInFinder:${path}`),
    openInTerminal: (path) => calls.push(`openInTerminal:${path}`),
  };
}

/** A terminal whose every action records its name. */
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

/** Every row's key, in order. */
function keys(rows: readonly MenuRow[]): readonly string[] {
  return placeRows(rows).map((placed) => placed.key);
}

describe("projectMenuRows", () => {
  const project = fakeProject({ name: "janela", directory: absolutePath("/src/janela") });

  test("every row acts on the project it was opened over, not on the selection", () => {
    // The whole reason a context menu exists beside the menu bar: `COMMANDS`
    // acts on what is selected, and right-clicking a project you have not
    // opened has to act on *that* project.
    const actions = recordingActions();
    const rows = projectMenuRows(project, actions);

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(actions.calls).toEqual([
      `newSession:${project.id}`,
      `newBranchSession:${project.id}`,
      "revealInFinder:/src/janela",
      "openInTerminal:/src/janela",
      `openProjectSettings:${project.id}`,
      `removeProject:${project.id}`,
    ]);
  });

  test("a folder that is not a repository offers the branch row, disabled", () => {
    // Shown rather than hidden: a row that vanishes teaches nothing, and "why
    // can I not make a branch session here" is exactly what it answers.
    // No `git` facts, which is exactly the question `supportsWorktrees` asks.
    const { git: _git, ...plain } = fakeProject({ name: "notes" });

    expect(labels(projectMenuRows(plain, recordingActions()))).toContain("New Branch Session…");
    expect(row(projectMenuRows(plain, recordingActions()), "New Branch Session…").disabled).toBe(
      true,
    );
    expect(row(projectMenuRows(project, recordingActions()), "New Branch Session…").disabled).toBe(
      false,
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
    // The row is never hidden: a menu whose first row appears and disappears is
    // a menu whose other rows move under the pointer.
    const withSelection = terminalMenuRows(terminalTarget(true, []));
    const without = terminalMenuRows(terminalTarget(false, []));

    expect(labels(withSelection)).toEqual(labels(without));
    expect(row(withSelection, "Copy").disabled).toBe(false);
    expect(row(without, "Copy").disabled).toBe(true);
    // Pasting does not depend on a selection, and the clipboard is not read to
    // find out: that is a permission prompt on some platforms.
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
    // `closeTerminals` is what names the cost — including of the last one — so a
    // guard here would be a second answer to the same question.
    const rows = terminalMenuRows(terminalTarget(false, []));

    expect(row(rows, "Close Terminal").destructive).toBe(true);
    expect(row(rows, "Close Terminal").disabled).toBeUndefined();
  });
});

describe("tabMenuRows and windowMenuRows", () => {
  test("a tab's rows act on that tab", () => {
    const calls: string[] = [];
    const rows = tabMenuRows({
      newTerminal: () => calls.push("newTerminal"),
      splitRight: () => calls.push("splitRight"),
      splitDown: () => calls.push("splitDown"),
      closeTab: () => calls.push("closeTab"),
    });

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(calls).toEqual(["newTerminal", "splitRight", "splitDown", "closeTab"]);
    expect(row(rows, "Close Tab").destructive).toBe(true);
  });

  test("the window's menu dispatches commands, and only the three that start something", () => {
    // The window is the one context with nothing under the pointer, so it is the
    // only menu that may carry window-wide commands — and it is not a copy of
    // the menu bar: `COMMANDS` has twenty-odd rows and this has three.
    const dispatched: string[] = [];
    const rows = windowMenuRows((id) => dispatched.push(id));

    for (const label of labels(rows)) row(rows, label).onSelect();

    expect(dispatched).toEqual(["newSession", "addProject", "showCommands"]);
  });
});

describe("placeRows", () => {
  test("the numbers count selectable rows, so a label or separator takes none", () => {
    // The number is how the fluid-hover highlight finds a row's box. Counting
    // children instead would leave a gap at every separator, and the highlight
    // would sit on the wrong row from there down.
    const rows: readonly MenuRow[] = [
      { kind: "label", label: "janela" },
      { kind: "item", label: "New Session…", onSelect: () => {} },
      { kind: "separator" },
      { kind: "item", label: "Remove…", onSelect: () => {}, destructive: true },
    ];

    expect(placeRows(rows).map((placed) => placed.index)).toEqual([-1, 0, -1, 1]);
  });

  test("keys come from the labels, not from the position", () => {
    // A menu whose rows change with the context — Copy appearing, a project's
    // Remove — would otherwise re-key every row below the one that changed, and
    // React would remount rows that did not change.
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
