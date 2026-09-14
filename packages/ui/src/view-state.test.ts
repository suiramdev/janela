import { describe, expect, test } from "bun:test";

import type { SessionStore } from "@janela/client";
import type { Session, SessionID, TerminalID } from "@janela/core";

import { withFocusedTab } from "./layout-edits.ts";
import { fakeSession, fakeSurfaceHandle, fakeTerminal } from "./test-fakes.ts";
import { createViewState } from "./view-state.ts";

/**
 * A mirror whose `sessions` can be swapped, which is what the store reads at the
 * moment of an edit — the fact `applyLayout` exists to respect.
 */
function fakeStore(initial: readonly Session[]): SessionStore & {
  replace(sessions: readonly Session[]): void;
} {
  let sessions = initial;
  let selection: SessionID | undefined;
  return {
    get sessions(): readonly Session[] {
      return sessions;
    },
    get selection(): SessionID | undefined {
      return selection;
    },
    set selection(next: SessionID | undefined) {
      selection = next;
    },
    terminalStates: {},
    launchProfiles: [],
    launchProfileAvailability: {},
    inProject: () => [],
    standaloneSessions: sessions,
    isRunning: () => false,
    subscribe: () => () => {},
    replace(next: readonly Session[]): void {
      sessions = next;
    },
  };
}

const twoTabs = (first: TerminalID, second: TerminalID): Session["layout"] => ({
  tabs: [
    { root: { kind: "terminal", id: first }, focusedTerminalID: first },
    { root: { kind: "terminal", id: second }, focusedTerminalID: second },
  ],
  focusedTabIndex: 0,
});

describe("focusTerminal", () => {
  test("selects the owning session and focuses the tab holding the terminal", () => {
    const [a, b] = [fakeTerminal({ title: "a" }), fakeTerminal({ title: "b" })];
    const session = fakeSession({ terminals: [a, b], layout: twoTabs(a.id, b.id) });
    const other = fakeSession();
    const store = fakeStore([other, session]);
    const view = createViewState(store);
    store.selection = other.id;

    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    view.focusTerminal(b.id);

    expect(store.selection).toBe(session.id);
    expect(view.layouts.get(session.id)?.local.focusedTabIndex).toBe(1);
    expect(notifications).toBe(1);
  });

  test("an id the mirror does not have changes nothing and notifies nobody", () => {
    const store = fakeStore([fakeSession()]);
    const view = createViewState(store);
    store.selection = undefined;
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    view.focusTerminal("00000000-0000-4000-8000-000000000000" as TerminalID);

    expect(store.selection).toBeUndefined();
    expect(view.layouts.size).toBe(0);
    expect(notifications).toBe(0);
  });

  test("gives the mounted surface keyboard focus", () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });
    const view = createViewState(fakeStore([session]));
    const handle = fakeSurfaceHandle();
    view.registerSurface(terminal.id, handle);

    view.focusTerminal(terminal.id);

    expect(handle.calls).toEqual(["focus"]);
    expect(view.surface(terminal.id)).toBe(handle);
  });
});

describe("applyLayout", () => {
  test("re-adopts when the daemon replaced the layout under an edit", () => {
    const [a, b] = [fakeTerminal(), fakeTerminal()];
    const session = fakeSession({ terminals: [a, b], layout: twoTabs(a.id, b.id) });
    const store = fakeStore([session]);
    const view = createViewState(store);

    view.applyLayout(session.id, (layout) => withFocusedTab(layout, 1));
    expect(view.layouts.get(session.id)?.local.focusedTabIndex).toBe(1);

    // The daemon sent a new layout — the tabs came back the other way round. The
    // local edit was made against a layout that no longer exists, so the next edit
    // starts from the tree the daemon says is on screen now (the tab *selection*
    // is this window's and survives: see `resolveLocalLayout`).
    const replaced = { ...session, layout: twoTabs(b.id, a.id) };
    store.replace([replaced]);

    view.applyLayout(replaced.id, (layout) => withFocusedTab(layout, 0));
    const entry = view.layouts.get(replaced.id);
    expect(entry?.base).toBe(replaced.layout);
    expect(entry?.local.tabs[0]?.focusedTerminalID).toBe(b.id);
    expect(entry?.local.focusedTabIndex).toBe(0);
  });

  test("a change that changed nothing is not a notification", () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });
    const view = createViewState(fakeStore([session]));
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    view.applyLayout(session.id, (layout) => layout);

    expect(notifications).toBe(0);
  });
});

describe("sheets", () => {
  test("one sheet at a time, and closing an already-closed one is silent", () => {
    const view = createViewState(fakeStore([]));
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    view.openSheet({ kind: "jumpList" });
    expect(view.sheet).toEqual({ kind: "jumpList" });
    view.openSheet({ kind: "commands" });
    expect(view.sheet).toEqual({ kind: "commands" });
    view.closeSheet();
    expect(view.sheet).toBeUndefined();

    const settled = notifications;
    view.closeSheet();
    expect(notifications).toBe(settled);
  });
});

describe("screens", () => {
  test("settings opens on General, keeps its tab when asked again, and goes back", () => {
    const view = createViewState(fakeStore([]));
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    expect(view.screen).toEqual({ kind: "workspace" });
    view.showSettings();
    expect(view.screen).toEqual({ kind: "settings", tab: "general" });
    view.showSettings("terminal");
    expect(view.screen).toEqual({ kind: "settings", tab: "terminal" });
    // ⌘, pressed again is not a trip back to the first tab.
    view.showSettings();
    expect(view.screen).toEqual({ kind: "settings", tab: "terminal" });

    const settled = notifications;
    view.showSettings("terminal");
    expect(notifications).toBe(settled);

    view.showWorkspace();
    expect(view.screen).toEqual({ kind: "workspace" });
    view.showWorkspace();
    expect(notifications).toBe(settled + 1);
  });
});

describe("registerSurface", () => {
  test("a remount keeps the new handle when the old one unregisters", () => {
    const view = createViewState(fakeStore([]));
    const id = "t" as TerminalID;
    const first = fakeSurfaceHandle();
    const second = fakeSurfaceHandle();

    const releaseFirst = view.registerSurface(id, first);
    view.registerSurface(id, second);
    releaseFirst();

    expect(view.surface(id)).toBe(second);
  });
});
