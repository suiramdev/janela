import { describe, expect, test } from "bun:test";

import type { SessionStore } from "@janela/client";
import type { ProjectID, Session, SessionID, TerminalID } from "@janela/core";

import { fakeSession, fakeSurfaceHandle, fakeTerminal } from "../lib/test-fakes/index.ts";
import { DEFAULT_GLOBAL_SETTINGS, withTerminalFontSize } from "./global-settings.ts";
import { withFocusedTab } from "./local-layout.ts";
import {
  EMPTY_SETTINGS_DRAFT,
  type SettingsDraft,
  draftSettings,
  withDraftSettings,
} from "./settings-draft.ts";
import { createViewState, sameRoute } from "./view-state.ts";

const projectID = (raw: string): ProjectID => raw as ProjectID;

const twoTabs = (first: TerminalID, second: TerminalID): Session["layout"] => ({
  tabs: [
    { root: { kind: "terminal", id: first }, focusedTerminalID: first },
    { root: { kind: "terminal", id: second }, focusedTerminalID: second },
  ],
  focusedTabIndex: 0,
});

const edited = (size: number): SettingsDraft =>
  withDraftSettings(EMPTY_SETTINGS_DRAFT, withTerminalFontSize(DEFAULT_GLOBAL_SETTINGS, size));

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
  test("settings opens on Terminal, keeps its route when asked again, and goes back", () => {
    const view = createViewState(fakeStore([]));
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    expect(view.screen).toEqual({ kind: "workspace" });

    view.showSettings();

    expect(view.screen).toEqual({ kind: "settings", route: { kind: "tab", tab: "terminal" } });

    view.showSettings({ kind: "tab", tab: "daemon" });

    expect(view.screen).toEqual({ kind: "settings", route: { kind: "tab", tab: "daemon" } });

    view.showSettings();

    expect(view.screen).toEqual({ kind: "settings", route: { kind: "tab", tab: "daemon" } });

    const settled = notifications;
    view.showSettings({ kind: "tab", tab: "daemon" });

    expect(notifications).toBe(settled);

    view.showWorkspace();

    expect(view.screen).toEqual({ kind: "workspace" });

    view.showWorkspace();

    expect(notifications).toBe(settled + 1);
  });

  test("a project is a route, and ⌘, comes back to the project you were in", () => {
    const view = createViewState(fakeStore([]));
    const route = { kind: "project", projectID: projectID("p") } as const;

    view.showSettings(route);

    expect(view.screen).toEqual({ kind: "settings", route });

    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });
    view.showSettings({ kind: "project", projectID: projectID("p") });
    view.showSettings();

    expect(notifications).toBe(0);
    expect(view.screen).toEqual({ kind: "settings", route });
  });

  test("two routes are the same route only when they name the same pane", () => {
    const terminal = { kind: "tab", tab: "terminal" } as const;
    const project = { kind: "project", projectID: projectID("p") } as const;

    expect(sameRoute(terminal, { kind: "tab", tab: "terminal" })).toBe(true);
    expect(sameRoute(terminal, { kind: "tab", tab: "daemon" })).toBe(false);
    expect(sameRoute(project, { kind: "project", projectID: projectID("p") })).toBe(true);
    expect(sameRoute(project, { kind: "project", projectID: projectID("q") })).toBe(false);
    expect(sameRoute(terminal, project)).toBe(false);
  });
});

describe("the settings draft", () => {
  test("opens clean, and an edit makes it dirty", () => {
    const view = createViewState(fakeStore([]));

    expect(view.hasUnsavedSettings).toBe(false);

    view.editSettingsDraft(edited(20));

    expect(view.hasUnsavedSettings).toBe(true);
    expect(draftSettings(view.settingsDraft, DEFAULT_GLOBAL_SETTINGS).terminalFontSize).toBe(20);
  });

  test("survives leaving settings, because Back is not an answer to the bar", () => {
    const view = createViewState(fakeStore([]));
    view.showSettings();
    view.editSettingsDraft(edited(20));

    view.showWorkspace();
    view.showSettings();

    expect(view.hasUnsavedSettings).toBe(true);
    expect(draftSettings(view.settingsDraft, DEFAULT_GLOBAL_SETTINGS).terminalFontSize).toBe(20);
  });

  test("a save goes quiet without discarding what is on screen", () => {
    const view = createViewState(fakeStore([]));
    view.editSettingsDraft(edited(20));

    view.settingsDraftSaved();

    expect(view.hasUnsavedSettings).toBe(false);
    expect(draftSettings(view.settingsDraft, DEFAULT_GLOBAL_SETTINGS).terminalFontSize).toBe(20);
  });

  test("a revert goes back to the last save, not to the mirror", () => {
    const view = createViewState(fakeStore([]));
    view.editSettingsDraft(edited(20));
    view.settingsDraftSaved();
    view.editSettingsDraft(edited(30));

    view.revertSettingsDraft();

    expect(view.hasUnsavedSettings).toBe(false);
    expect(draftSettings(view.settingsDraft, DEFAULT_GLOBAL_SETTINGS).terminalFontSize).toBe(20);
  });

  test("notifies on an edit, a save and a revert, and on nothing else", () => {
    const view = createViewState(fakeStore([]));
    let notifications = 0;
    view.subscribe(() => {
      notifications += 1;
    });

    const draft = edited(20);
    view.editSettingsDraft(draft);
    view.editSettingsDraft(draft);

    expect(notifications).toBe(1);

    view.settingsDraftSaved();
    view.settingsDraftSaved();

    expect(notifications).toBe(2);

    view.revertSettingsDraft();

    expect(notifications).toBe(2);
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
