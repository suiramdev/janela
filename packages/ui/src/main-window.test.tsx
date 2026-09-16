import { describe, expect, test } from "bun:test";

import { createStores } from "@janela/client";
import type {
  ConnectionStatus,
  DaemonConnection,
  ProjectStore,
  SessionStore,
} from "@janela/client";
import {
  absolutePath,
  emptyLayout,
  instant,
  newAutomationID,
  singleTerminalLayout,
  splitPane,
  type GridSize,
  type Pane,
  type Project,
  type ProjectID,
  type Session,
  type SessionID,
  type SessionLayout,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import {
  Elevated,
  sizeMap,
  SidebarProvider,
  SizeProvider,
  useSurface,
  type SizeVariant,
} from "@janela/design";
import type { StateUpdate } from "@janela/protocol";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppSidebar } from "./app-sidebar.tsx";
import {
  ClientEnvironmentProvider,
  type ClientEnvironment,
  type WindowControls,
} from "./client-environment.tsx";
import {
  resolveLocalLayout,
  tabsInCloseScope,
  withFocusedTab,
  withFocusedTerminal,
  withFraction,
  type LocalLayoutEntry,
  type PanePath,
} from "./layout-edits.ts";
import {
  MainWindow,
  SessionDetail,
  attachPane,
  closeQuestionScope,
  shouldStartOnAttach,
  tabTerminals,
} from "./main-window.tsx";
import { EMPTY_SETTINGS_DRAFT, withDraftProjectSettings } from "./settings-draft.ts";
import { sessionStatus, sidebarRows } from "./sidebar-model.ts";
import {
  hiddenWindowControls,
  inertClipboard,
  inertNativeShell,
  overlaidWindowControls,
  recordingConfirmations,
  memorySettingsStore,
  neverCommands,
  recordingService,
} from "./test-fakes.ts";
import { createViewState } from "./view-state.ts";
import { ContentCard, WINDOW_CONTROLS_ROOM, WINDOW_DRAG_REGION } from "./window-chrome.tsx";

// ---------------------------------------------------------------------------
// Values. Built here rather than imported: @janela/client's fakes are not
// exported, and a client-side view has no business reaching into a daemon
// package for a fixture.
// ---------------------------------------------------------------------------

const AT = instant("2026-01-01T00:00:00.000Z");

/** A dispatch that runs nothing: markup rendering never presses a button. */
const ignoreCommand = (): undefined => undefined;

const terminalID = (raw: string): TerminalID => raw as TerminalID;
const sessionID = (raw: string): SessionID => raw as SessionID;
const projectID = (raw: string): ProjectID => raw as ProjectID;

function terminal(id: string, title = id): TerminalDescriptor {
  return {
    id: terminalID(id),
    title,
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: AT,
  };
}

function session(
  id: string,
  extra: {
    readonly project?: string;
    readonly terminals?: readonly TerminalDescriptor[];
    readonly layout?: SessionLayout;
  } = {},
): Session {
  return {
    id: sessionID(id),
    ...(extra.project === undefined ? {} : { projectID: projectID(extra.project) }),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    backing: { kind: "folder" },
    terminals: extra.terminals ?? [],
    layout: extra.layout ?? emptyLayout,
    accent: "none",
    createdAt: AT,
    lastActiveAt: AT,
    isPinned: false,
  };
}

function project(id: string, isExpanded: boolean): Project {
  return {
    id: projectID(id),
    name: id,
    directory: absolutePath(`/repos/${id}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: [],
      isForgeEnabled: false,
    },
    accent: "none",
    isExpanded,
    addedAt: AT,
  };
}

const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = {};

// ---------------------------------------------------------------------------
// Structural fakes. `subscribe` does nothing: markup rendering never notifies,
// and every read goes through the server snapshot.
// ---------------------------------------------------------------------------

/** A subscription that never notifies. */
const noop = (): (() => void) => () => {};

function fakeEnvironment(options: {
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly states?: Readonly<Record<TerminalID, TerminalState>>;
  readonly selection?: SessionID;
  readonly status?: ConnectionStatus;
  readonly windowControls?: WindowControls;
}): ClientEnvironment {
  const sessions = options.sessions ?? [];
  const states = options.states ?? NO_STATES;

  const projects: ProjectStore = {
    projects: options.projects ?? [],
    find: (id) => (options.projects ?? []).find((candidate) => candidate.id === id),
    subscribe: noop,
  };
  const sessionStore: SessionStore = {
    sessions,
    selection: options.selection,
    terminalStates: states,
    launchProfiles: [],
    launchProfileAvailability: {},
    inProject: (id) => sessions.filter((candidate) => candidate.projectID === id),
    standaloneSessions: sessions.filter((candidate) => candidate.projectID === undefined),
    isRunning: (id) => {
      const found = sessions.find((candidate) => candidate.id === id);
      return (found?.terminals ?? []).some((entry) => states[entry.id]?.kind === "running");
    },
    subscribe: noop,
  };
  const connection: DaemonConnection = {
    status: options.status ?? { kind: "idle" },
    isStale: false,
    connect: async () => {},
    request: async () => undefined,
    sendInput: () => {},
    onOutput: noop,
    onAttention: noop,
    subscribe: noop,
    disconnect: async () => {},
  };

  return {
    projects,
    sessions: sessionStore,
    connection,
    view: createViewState(sessionStore),
    commands: neverCommands(),
    native: inertNativeShell(),
    windowControls: options.windowControls ?? overlaidWindowControls,
    confirmations: recordingConfirmations(),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    service: recordingService(),
    restartDaemon: () => {},
  };
}

/**
 * A `ClientEnvironment` over a **real mirror**, fed one `StateUpdate`.
 *
 * The fake above takes `selection` as an option, so it can only ever prove what a
 * view does with a selection it was handed. This one proves what the client stack
 * *decides* when the daemon sends state and the user has chosen nothing — which is
 * the whole of #46. The update is written out by hand because `@janela/client`'s
 * fixtures are deliberately not exported.
 */
function environmentOver(state: {
  readonly sessions: readonly Session[];
  readonly projects?: readonly Project[];
  readonly terminalStates?: Readonly<Record<TerminalID, TerminalState>>;
}): ClientEnvironment {
  const stores = createStores();
  const update: StateUpdate = {
    sessions: state.sessions,
    projects: state.projects ?? [],
    terminalStates: state.terminalStates ?? NO_STATES,
    launchProfiles: [],
    launchProfileAvailability: {},
    isFullSnapshot: true,
  };
  stores.mirror.apply(update);

  return {
    projects: stores.projects,
    sessions: stores.sessions,
    // The same inert connection the fake uses: nothing here requests anything.
    connection: fakeEnvironment({}).connection,
    view: createViewState(stores.sessions),
    commands: neverCommands(),
    native: inertNativeShell(),
    windowControls: overlaidWindowControls,
    confirmations: recordingConfirmations(),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    service: recordingService(),
    restartDaemon: () => {},
  };
}

// ---------------------------------------------------------------------------
// Sidebar model
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

describe("resolveLocalLayout", () => {
  const layout = singleTerminalLayout(terminalID("a"));
  const ids = [terminalID("a")];

  test("a clean mirror layout is adopted by reference", () => {
    const resolved = resolveLocalLayout(undefined, layout, ids);

    expect(resolved.base).toBe(layout);
    expect(resolved.local).toBe(layout);
  });

  test("a layout that violates the algebra is repaired before adoption", () => {
    const broken: SessionLayout = {
      tabs: [
        {
          root: { kind: "terminal", id: terminalID("gone") },
          focusedTerminalID: terminalID("gone"),
        },
      ],
      focusedTabIndex: 0,
    };

    const resolved = resolveLocalLayout(undefined, broken, ids);

    expect(resolved.base).toBe(broken);
    expect(resolved.local).not.toBe(broken);
    expect(resolved.local.tabs).toHaveLength(0);
  });

  test("local edits survive while the mirror layout is the same object", () => {
    const edited = withFocusedTab(
      { tabs: [...layout.tabs, ...layout.tabs], focusedTabIndex: 0 },
      1,
    );
    const entry: LocalLayoutEntry = { base: layout, local: edited };

    expect(resolveLocalLayout(entry, layout, ids)).toBe(entry);
  });

  test("a new mirror layout discards the local edits", () => {
    const entry: LocalLayoutEntry = { base: layout, local: emptyLayout };
    const replacement = singleTerminalLayout(terminalID("a"));

    const resolved = resolveLocalLayout(entry, replacement, ids);

    expect(resolved.local).toBe(replacement);
  });

  test("a daemon-side split keeps the tab this window was looking at", () => {
    const twoTabs: SessionLayout = {
      tabs: [
        { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
        { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
      ],
      focusedTabIndex: 1,
    };
    const entry: LocalLayoutEntry = { base: twoTabs, local: withFocusedTab(twoTabs, 0) };

    // The daemon split a pane: a whole new layout, same stored tab selection.
    const split: SessionLayout = { ...twoTabs, tabs: [...twoTabs.tabs] };
    const resolved = resolveLocalLayout(entry, split, [terminalID("a"), terminalID("b")]);

    // Tab selection is this window's. Adopting the daemon's would move the user
    // off the tab they were on every time they split a pane.
    expect(resolved.local.focusedTabIndex).toBe(0);
  });

  test("the daemon moving the tab itself is followed: that is what ⌘T is", () => {
    const oneTab: SessionLayout = {
      tabs: [
        { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
      ],
      focusedTabIndex: 0,
    };
    const entry: LocalLayoutEntry = { base: oneTab, local: oneTab };

    const appended: SessionLayout = {
      tabs: [
        ...oneTab.tabs,
        { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
      ],
      focusedTabIndex: 1,
    };
    const resolved = resolveLocalLayout(entry, appended, [terminalID("a"), terminalID("b")]);

    expect(resolved.local.focusedTabIndex).toBe(1);
  });
});

/** The fraction of a split, or nothing for a bare terminal. */
const fractionOf = (pane: Pane): number | undefined =>
  pane.kind === "split" ? pane.fraction : undefined;

describe("withFraction", () => {
  const split: Pane = {
    kind: "split",
    axis: "horizontal",
    fraction: 0.5,
    first: { kind: "terminal", id: terminalID("a") },
    second: {
      kind: "split",
      axis: "vertical",
      fraction: 0.5,
      first: { kind: "terminal", id: terminalID("b") },
      second: { kind: "terminal", id: terminalID("c") },
    },
  };
  const root: PanePath = [];

  test("the empty path addresses the root split", () => {
    expect(fractionOf(withFraction(split, root, 0.3))).toBe(0.3);
  });

  test("a nested path rebuilds only that path", () => {
    const next = withFraction(split, ["second"], 0.25);

    expect(next.kind === "split" && fractionOf(next.second)).toBe(0.25);
    // The untouched subtree is the same object: a divider drag must not re-render
    // the pane on the other side of the window.
    expect(next.kind === "split" && next.first).toBe(split.first);
  });

  test("clamps to the range a pane can still be closed from", () => {
    expect(fractionOf(withFraction(split, root, 0))).toBe(0.05);
    expect(fractionOf(withFraction(split, root, 9))).toBe(0.95);
    expect(fractionOf(withFraction(split, root, Number.NaN))).toBe(0.5);
  });
  test("a path that names nothing leaves the tree alone", () => {
    expect(withFraction(split, ["first"], 0.2)).toBe(split);
    expect(withFraction(split, ["second", "first", "second"], 0.2)).toBe(split);
  });
});

describe("withFocusedTerminal", () => {
  const first = singleTerminalLayout(terminalID("a")).tabs[0];
  const layout: SessionLayout = {
    tabs: [
      first ?? {
        root: { kind: "terminal", id: terminalID("a") },
        focusedTerminalID: terminalID("a"),
      },
      {
        root: {
          kind: "split",
          axis: "horizontal",
          fraction: 0.5,
          first: { kind: "terminal", id: terminalID("b") },
          second: { kind: "terminal", id: terminalID("c") },
        },
        focusedTerminalID: terminalID("b"),
      },
    ],
    focusedTabIndex: 0,
  };

  test("focuses the terminal and the tab holding it", () => {
    const next = withFocusedTerminal(layout, terminalID("c"));

    expect(next.focusedTabIndex).toBe(1);
    expect(next.tabs[1]?.focusedTerminalID).toBe(terminalID("c"));
  });

  test("a terminal that is not in the layout changes nothing", () => {
    expect(withFocusedTerminal(layout, terminalID("zzz"))).toBe(layout);
  });

  test("focusing what is already focused changes nothing", () => {
    expect(withFocusedTerminal(layout, terminalID("a"))).toBe(layout);
  });
});

describe("withFocusedTab", () => {
  const layout: SessionLayout = {
    tabs: [
      { root: { kind: "terminal", id: terminalID("a") }, focusedTerminalID: terminalID("a") },
      { root: { kind: "terminal", id: terminalID("b") }, focusedTerminalID: terminalID("b") },
    ],
    focusedTabIndex: 0,
  };

  test("clamps rather than trusts", () => {
    expect(withFocusedTab(layout, 9).focusedTabIndex).toBe(1);
    expect(withFocusedTab(layout, -3).focusedTabIndex).toBe(0);
  });

  test("an empty layout has no tab to focus", () => {
    expect(withFocusedTab(emptyLayout, 1)).toBe(emptyLayout);
  });
});

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

function recordingConnection(options: { readonly failing?: boolean } = {}): {
  readonly connection: Pick<DaemonConnection, "request" | "onOutput">;
  readonly calls: string[];
  readonly requests: unknown[];
} {
  const calls: string[] = [];
  const requests: unknown[] = [];
  return {
    calls,
    requests,
    connection: {
      onOutput: (_id, _handler) => {
        calls.push("onOutput");
        return () => calls.push("unsubscribe");
      },
      request: async (message) => {
        calls.push(message.type);
        requests.push(message);
        if (options.failing === true) throw new Error("no connection");
        return undefined;
      },
    },
  };
}

describe("attachPane", () => {
  const viewport: GridSize = { columns: 80, rows: 24 };

  test("subscribes before attaching: the reply is a full repaint", () => {
    const { connection, calls, requests } = recordingConnection();

    attachPane(connection, terminalID("t"), () => {}, viewport);

    expect(calls).toEqual(["onOutput", "attach"]);
    expect(requests[0]).toEqual({ type: "attach", terminalID: terminalID("t"), viewport });
  });

  test("cleanup unsubscribes, then detaches", () => {
    const { connection, calls } = recordingConnection();

    attachPane(connection, terminalID("t"), () => {}, viewport)();

    expect(calls).toEqual(["onOutput", "attach", "unsubscribe", "detach"]);
  });

  test("a rejected request does not throw at the caller", async () => {
    const { connection } = recordingConnection({ failing: true });

    const release = attachPane(connection, terminalID("t"), () => {}, viewport);
    release();
    // The rejections are swallowed inside; nothing here should see them.
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

describe("AppSidebar markup", () => {
  /**
   * The sidebar is a `SidebarProvider` child now: `SidebarMenuButton` reads the
   * expanded/collapsed state from it, and a row rendered outside one throws.
   */
  function renderSidebar(environment: ClientEnvironment): string {
    return renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <SidebarProvider>
          <AppSidebar dispatch={ignoreCommand} />
        </SidebarProvider>
      </ClientEnvironmentProvider>,
    );
  }

  test("a session needing attention says so in its name", () => {
    const withAttention = session("fix/pty", { terminals: [terminal("t1")] });
    const environment = fakeEnvironment({
      sessions: [withAttention],
      states: { [terminalID("t1")]: { kind: "needsAttention" } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="fix/pty — needs attention"');
    // The dot is painted in the attention colour, whatever element carries it:
    // the claim is that a state has a colour, not which tag it is drawn with.
    expect(markup).toContain("text-attention");
  });

  test("project rows are disclosures and the selected session is current", () => {
    const member = session("main", { project: "p" });
    const environment = fakeEnvironment({
      projects: [project("p", true)],
      sessions: [member],
      selection: sessionID("main"),
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-current="true"');
  });

  test("the header offers search, collapsing and creation, above the scroller", () => {
    const markup = renderSidebar(fakeEnvironment({ projects: [project("p", false)] }));

    // Two compact controls at the top, then the rows that make something.
    expect(markup).toContain('aria-label="Search"');
    expect(markup).toContain("Toggle Sidebar");
    expect(markup).toContain("New Session");
    expect(markup).toContain('aria-label="New Project"');
    expect(markup).toContain('aria-label="Filter: All Sessions"');
    // The header is a sibling of the scroller, not inside it: that is the whole
    // reason those controls survive a long list.
    expect(markup.indexOf('data-sidebar="header"')).toBeLessThan(
      markup.indexOf('data-sidebar="content"'),
    );
    // And the rows are inside a scroller of their own.
    expect(markup).toContain('data-slot="scroll-area-viewport"');
  });

  test("the window controls get the head of the header row, and fullscreen takes it back", () => {
    const overlaid = renderSidebar(fakeEnvironment({}));
    const fullscreen = renderSidebar(fakeEnvironment({ windowControls: hiddenWindowControls }));

    // The traffic lights are drawn by macOS over the leading end of this row, so
    // the room has to come before the first control rather than after it.
    expect(overlaid.indexOf(WINDOW_CONTROLS_ROOM)).toBeGreaterThan(-1);
    expect(overlaid.indexOf(WINDOW_CONTROLS_ROOM)).toBeLessThan(
      overlaid.indexOf('aria-label="Search"'),
    );

    // Fullscreen: no buttons to dodge, so no gap in front of the search button.
    expect(fullscreen).not.toContain(WINDOW_CONTROLS_ROOM);
  });

  test("the header row is the band that drags the window, in both states", () => {
    const region = `data-tauri-drag-region="${WINDOW_DRAG_REGION}"`;

    for (const markup of [
      renderSidebar(fakeEnvironment({})),
      // Fullscreen has no buttons in the row and is still a title bar: a window
      // with no way to be moved or zoomed is what removing the system one cost.
      renderSidebar(fakeEnvironment({ windowControls: hiddenWindowControls })),
    ]) {
      // On the row, not on a child of it: the whole band has to drag, and Tauri's
      // script only walks *up* from what was pressed. A child carrying it drags
      // exactly its own box, which is how this broke the first time.
      expect(markup.indexOf(region)).toBeGreaterThan(-1);
      expect(markup.indexOf(region)).toBeLessThan(markup.indexOf('aria-label="Search"'));
    }
  });

  test("the Inbox row promises nothing: disabled, and badged as planned", () => {
    const markup = renderSidebar(fakeEnvironment({}));

    expect(markup).toContain("Inbox");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Planned");
  });

  test("each project offers a new session on hover, named after the project", () => {
    const markup = renderSidebar(fakeEnvironment({ projects: [project("janela", false)] }));

    expect(markup).toContain('aria-label="New Session in janela"');
    expect(markup).toContain('data-sidebar="menu-action"');
  });

  test("an empty sidebar says which nothing it is", () => {
    expect(renderSidebar(fakeEnvironment({}))).toContain("No sessions yet");
  });

  test("every session sits under one Sessions heading, standalone or not", () => {
    const markup = renderSidebar(
      fakeEnvironment({
        projects: [project("janela", true)],
        sessions: [session("loose"), session("inside", { project: "janela" })],
      }),
    );

    // One group label, and it is not "Projects": the list is a list of sessions.
    expect(markup.split('data-sidebar="group-label"')).toHaveLength(2);
    const label = markup.indexOf('data-sidebar="group-label"');
    expect(markup.slice(label, markup.indexOf("loose"))).toContain("Sessions");
    expect(markup).not.toContain(">Projects<");
    // Standalone still leads, project sessions still indent: the order is the same rows.
    expect(markup.indexOf("loose")).toBeLessThan(markup.indexOf("janela"));
    expect(markup.indexOf("janela")).toBeLessThan(markup.indexOf("inside"));
  });
});

/** The opening tag of the window's content column, attributes and all. */
function insetColumn(markup: string): string {
  const at = markup.indexOf('<main data-slot="sidebar-inset"');
  expect(at).toBeGreaterThan(-1);
  return markup.slice(at, markup.indexOf(">", at));
}

/** Which `Sidebar` variant a screen asked the primitive for. */
function sidebarVariant(markup: string): string {
  const match = /data-variant="([a-z]+)"/.exec(markup);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

const drawSettings = (
  environment: ClientEnvironment,
  route?: Parameters<ClientEnvironment["view"]["showSettings"]>[0],
): string => {
  environment.view.showSettings(route);
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <MainWindow />
    </ClientEnvironmentProvider>,
  );
};

/** One bar button's own tag: every button's classes mention `disabled:`. */
const barButton = (markup: string, label: "Save" | "Revert"): string =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? "";

describe("MainWindow markup", () => {
  test("no selection renders the welcome screen, not a detail view", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("No session open");
    // The screen a fresh install lands on offers both ways to make one.
    expect(markup).toContain("New Session");
    expect(markup).toContain("Add Project");
    expect(markup).not.toContain('role="tablist"');
  });

  test("settings fills the window exactly the way the workspace does", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    const draw = (): string =>
      renderToStaticMarkup(
        <ClientEnvironmentProvider environment={environment}>
          <MainWindow />
        </ClientEnvironmentProvider>,
      );

    const workspace = draw();
    environment.view.showSettings();
    const settings = draw();

    // Byte-identical chrome: the same inset column, and a sidebar with the same
    // variant beside it. Settings is the same window with different contents —
    // it used to be a second layout, with the sidebar against the window frame
    // and no way to collapse it.
    expect(insetColumn(settings)).toBe(insetColumn(workspace));
    expect(sidebarVariant(settings)).toBe(sidebarVariant(workspace));
    expect(settings).toContain("Background service");
  });

  test("a project's settings are a pane in the settings screen, reached by route", () => {
    const environment = fakeEnvironment({ projects: [project("janela", false)] });
    const draw = (): string =>
      renderToStaticMarkup(
        <ClientEnvironmentProvider environment={environment}>
          <MainWindow />
        </ClientEnvironmentProvider>,
      );

    environment.view.showSettings({ kind: "project", projectID: projectID("janela") });
    const markup = draw();

    // The project's own form, in the window rather than in a dialog: the
    // automation editor is copy no other pane renders.
    expect(markup).toContain("When a session is first opened");
    expect(markup).toContain("/repos/janela");
    // And the navigation says where you are.
    expect(markup).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*janela/);
  });

  test("a project the mirror does not have falls back to General, not to an empty pane", () => {
    // The removal arrives from the daemon while its pane is showing. A screen
    // that kept the route would leave the user looking at nothing, with a
    // selected row for a project that is gone.
    const environment = fakeEnvironment({ projects: [project("janela", false)] });
    environment.view.showSettings({ kind: "project", projectID: projectID("gone") });
    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("Background service");
    expect(markup).not.toContain("When a session is first opened");
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });

  /**
   * The bar that commits every tab. Driven through `MainWindow` because that is
   * the only place the draft, the panes and the bar meet — and because "the
   * violation is on another pane" is a claim about exactly that meeting.
   */
  describe("the settings bar", () => {
    test("is quiet at rest: nothing to save, and it does not say so twice", () => {
      const markup = drawSettings(fakeEnvironment({ projects: [project("janela", false)] }));

      expect(barButton(markup, "Save")).toContain('disabled=""');
      expect(barButton(markup, "Revert")).toContain('disabled=""');
      expect(markup).not.toContain("unsaved change");
    });

    test("counts an edit made on a pane the user has since left", () => {
      // The reach of one Save is the reason the count is there at all: the edit
      // below is a project's, and the pane on screen is Terminal.
      const environment = fakeEnvironment({ projects: [project("janela", false)] });
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, projectID("janela"), {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: [],
          isForgeEnabled: true,
        }),
      );
      const markup = drawSettings(environment, { kind: "tab", tab: "terminal" });

      expect(markup).toContain("1 unsaved change");
      expect(barButton(markup, "Save")).not.toContain('disabled=""');
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });

    test("refuses a save the daemon would reject, and names the pane to fix it on", () => {
      const environment = fakeEnvironment({ projects: [project("janela", false)] });
      environment.view.editSettingsDraft(
        withDraftProjectSettings(EMPTY_SETTINGS_DRAFT, projectID("janela"), {
          worktreeRoot: { kind: "siblingDirectory" },
          automation: [
            {
              id: newAutomationID(),
              event: "sessionStart",
              command: [""],
              isEnabled: true,
              timeoutSeconds: 30,
            },
          ],
          isForgeEnabled: false,
        }),
      );
      const markup = drawSettings(environment, { kind: "tab", tab: "notifications" });

      expect(barButton(markup, "Save")).toContain('disabled=""');
      // Named, and reachable: a disabled Save whose reason is three panes away
      // is a dead end.
      expect(markup).toContain("An enabled command needs an executable.");
      expect(markup).toContain("janela");
      // Revert is the way out, so it stays live.
      expect(barButton(markup, "Revert")).not.toContain('disabled=""');
    });
  });

  /**
   * The sheet is a dialog now, and a dialog's content is *portalled* — it renders
   * nothing at all on the server, so there is no markup here to assert about it.
   * What this test can still hold is the routing: the open sheet is a value on
   * `ViewState`, the host renders from it, and the window behind it keeps
   * rendering (the sheet is not a mode the mirror disappears into).
   */
  test("an open sheet is view state the window keeps rendering behind", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    environment.view.openSheet({ kind: "jumpList" });

    expect(environment.view.sheet).toEqual({ kind: "jumpList" });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    // The sidebar — and so the mirror — is still on screen underneath.
    expect(markup).toContain('data-sidebar="content"');
    expect(markup).toContain('aria-label="Filter: All Sessions"');
  });

  /**
   * The survival moment, at the seam where it is actually experienced.
   *
   * Driven through a **real `createStores()` mirror** rather than the structural
   * fake above, because the thing under test is the client stack answering "what am
   * I looking at" from a `StateUpdate` the daemon could really send — the fake
   * hands selection in as a prop and would prove nothing (#46).
   *
   * The guarantee is *the first frame that shows the session shows it selected*:
   * this renders **once**, after the snapshot, with no effect, no second pass and
   * nothing that could correct itself between paints.
   */
  test("the first frame after a relaunch shows the surviving session, not an empty pane", () => {
    const survivor = session("agent", {
      terminals: [terminal("t1", "claude")],
      layout: singleTerminalLayout(terminalID("t1")),
    });
    const environment = environmentOver({
      sessions: [survivor],
      terminalStates: { [terminalID("t1")]: { kind: "running" } },
    });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).not.toContain("No session open");
    // The terminal is on screen, and the sidebar row agrees with the pane.
    expect(markup).toContain('aria-label="Terminal: claude — running"');
    expect(markup).toContain('aria-current="true"');
  });

  test("an empty mirror still renders the empty state: there is nothing to select", () => {
    const environment = environmentOver({ sessions: [] });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("No session open");
  });
});

/**
 * One terminal pane's own markup: its wrapper, its bar, everything down to the
 * surface's label.
 *
 * Scoped deliberately. An assertion over the whole view would be about the tab
 * strip too, and the tab strip is *supposed* to follow pane focus — an untitled
 * tab is named for the terminal it is showing.
 */
function paneMarkup(markup: string, title: string): string {
  const at = markup.indexOf(`aria-label="Terminal: ${title} — `);
  expect(at).toBeGreaterThan(-1);
  const opening = markup.lastIndexOf('<div data-slot="terminal-pane"', at);
  expect(opening).toBeGreaterThan(-1);
  return markup.slice(opening, at);
}

/** The `class` attribute of the element carrying `marker`. */
function classOf(markup: string, marker: string): string {
  const at = markup.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const opening = markup.lastIndexOf("<", at);
  const closing = markup.indexOf(">", at);
  const match = /class="([^"]*)"/.exec(markup.slice(opening, closing));
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/** The same split, drawn twice, differing only in which half has the keyboard. */
function splitFocusing(id: TerminalID): SessionLayout {
  const split = splitPane(
    singleTerminalLayout(terminalID("t1")),
    terminalID("t1"),
    terminalID("t2"),
    "horizontal",
  );
  return withFocusedTerminal(split, id);
}

describe("tabTerminals", () => {
  test("a tab is every terminal in its tree, not the pane it happens to show", () => {
    const layout = splitFocusing(terminalID("t2"));

    // Closing a tab closes what is *in* it: the split half that is not focused
    // is not a separate tab and must not survive its tab being thrown away.
    expect(tabTerminals(layout, 0)).toEqual([terminalID("t1"), terminalID("t2")]);
    expect(tabTerminals(layout, 1)).toEqual([]);
  });
});

describe("tabsInCloseScope", () => {
  test("each scope is the run of tabs its label names", () => {
    expect(tabsInCloseScope(4, 1, "this")).toEqual([1]);
    expect(tabsInCloseScope(4, 1, "others")).toEqual([0, 2, 3]);
    expect(tabsInCloseScope(4, 1, "left")).toEqual([0]);
    expect(tabsInCloseScope(4, 1, "right")).toEqual([2, 3]);
    expect(tabsInCloseScope(4, 1, "all")).toEqual([0, 1, 2, 3]);
  });

  test("the ends name nothing on the side they have no tabs on", () => {
    expect(tabsInCloseScope(3, 0, "left")).toEqual([]);
    expect(tabsInCloseScope(3, 2, "right")).toEqual([]);
    expect(tabsInCloseScope(1, 0, "others")).toEqual([]);
  });

  test("a tab the strip no longer has names nothing, and takes no neighbours with it", () => {
    // The daemon owns the layout, so a terminal exiting anywhere renumbers the
    // strip — including under a menu that is already open. Every scope but
    // "all" is relative to a tab, and a stale index must close nothing rather
    // than everything to one side of where that tab used to be.
    for (const scope of ["this", "others", "left", "right"] as const) {
      expect(tabsInCloseScope(2, 5, scope)).toEqual([]);
      expect(tabsInCloseScope(2, -1, scope)).toEqual([]);
    }
    // "All" reads no index, so it still means every tab.
    expect(tabsInCloseScope(2, 5, "all")).toEqual([0, 1]);
  });
});

describe("closeQuestionScope", () => {
  test("only the tab's own ✕ asks about this tab", () => {
    // The gesture, not the count: "Close Other Tabs" beside one other tab asked
    // "Close this tab?" once, which is a user agreeing to the opposite of what
    // the row they picked does.
    expect(closeQuestionScope("this")).toBe("tab");
    for (const scope of ["others", "left", "right", "all"] as const) {
      expect(closeQuestionScope(scope)).toBe("tabs");
    }
  });
});

describe("SessionDetail markup", () => {
  /**
   * A detail view is a child of the sidebar layout: its tab strip carries the
   * control that brings a collapsed sidebar back, so it reads the same provider
   * the sidebar does.
   */
  function renderDetail(environment: ClientEnvironment, id: string): string {
    return renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <SidebarProvider>
          <SessionDetail sessionID={sessionID(id)} />
        </SidebarProvider>
      </ClientEnvironmentProvider>,
    );
  }

  test("a tab strip and a labelled surface carrying the terminal's state", () => {
    const withTerminal = session("s", {
      terminals: [terminal("t1", "zsh")],
      layout: singleTerminalLayout(terminalID("t1")),
    });
    const environment = fakeEnvironment({
      sessions: [withTerminal],
      states: { [terminalID("t1")]: { kind: "running" } },
      status: { kind: "connected" },
    });

    const markup = renderDetail(environment, "s");

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("zsh");
    expect(markup).toContain('aria-label="Terminal: zsh — running"');
    // The strip's three controls, at its end: they act on the tab showing.
    expect(markup).toContain('aria-label="Split Vertically"');
    expect(markup).toContain('aria-label="Split Horizontally"');
    expect(markup).toContain('aria-label="New Terminal"');
  });

  test("each tab and each terminal carries its own close control", () => {
    const split = session("s", {
      terminals: [terminal("t1", "zsh"), terminal("t2", "bash")],
      layout: splitFocusing(terminalID("t2")),
    });
    const environment = fakeEnvironment({
      sessions: [split],
      states: {
        [terminalID("t1")]: { kind: "running" },
        [terminalID("t2")]: { kind: "running" },
      },
      status: { kind: "connected" },
    });

    const markup = renderDetail(environment, "s");

    // The tab is named for the terminal it shows, and closing it takes the whole
    // tree with it; the two panes close one terminal each. Three controls, three
    // different targets.
    expect(markup).toContain('aria-label="Close tab: bash"');
    expect(markup).toContain('aria-label="Close terminal: zsh"');
    expect(markup).toContain('aria-label="Close terminal: bash"');
  });

  test("the shells are what is raised, not the region that holds them", () => {
    const split = session("s", {
      terminals: [terminal("t1", "zsh"), terminal("t2", "bash")],
      layout: splitFocusing(terminalID("t1")),
    });
    const markup = renderDetail(
      fakeEnvironment({ sessions: [split], status: { kind: "connected" } }),
      "s",
    );

    // Two panes, two elevations. Counting is the point: a surface on the region
    // behind them, or on a card wrapping the strip and the panes together, would
    // be a third — and would say "this box is raised" about a box the user never
    // thinks of, while drawing a frame around panes that already have an edge.
    expect([...markup.matchAll(/shadow-surface-\d/g)]).toHaveLength(2);
    expect(paneMarkup(markup, "zsh")).toContain("shadow-surface-2");
  });

  test("the chrome is a step of the size ladder, not a number per surface", () => {
    const split = session("s", {
      terminals: [terminal("t1", "zsh")],
      layout: singleTerminalLayout(terminalID("t1")),
    });
    const environment = fakeEnvironment({ sessions: [split], status: { kind: "connected" } });
    const drawn = (size: SizeVariant): string =>
      renderToStaticMarkup(
        <ClientEnvironmentProvider environment={environment}>
          <SizeProvider size={size}>
            <SidebarProvider>
              <SessionDetail sessionID={sessionID("s")} />
            </SidebarProvider>
          </SizeProvider>
        </ClientEnvironmentProvider>,
      );

    // Rendered at both steps, because matching `compact` proves nothing on its
    // own: a hand-written `h-7` matches it too. What the ladder being
    // load-bearing means is that the chrome *moves* when the step does — and
    // that nothing keeps the other step's height.
    for (const step of ["compact", "default"] as const) {
      const markup = drawn(step);
      const other = step === "compact" ? "default" : "compact";

      expect(markup).toContain(sizeMap[step].control);
      expect(markup).not.toContain(sizeMap[other].control);
      // And the segmented strip is a control too, not 4px taller than every
      // other one, which is what its own `h-8` used to make it.
      expect(classOf(markup, 'aria-label="Terminals"')).toContain(sizeMap[step].control);
    }
  });

  test("moving the keyboard between two panes changes nothing that is drawn", () => {
    const terminals = [terminal("t1", "zsh"), terminal("t2", "bash")];
    const states = {
      [terminalID("t1")]: { kind: "running" },
      [terminalID("t2")]: { kind: "running" },
    } as const;
    const drawn = (focused: TerminalID): string =>
      renderDetail(
        fakeEnvironment({
          sessions: [session("s", { terminals, layout: splitFocusing(focused) })],
          states,
          status: { kind: "connected" },
        }),
        "s",
      );

    // Byte-identical, and that is the claim: a pane has the keyboard because the
    // user just clicked or typed in it, and the caret already says so. An
    // outline, ring or tint on top is a signal for something nobody was confused
    // about, drawn around half the window.
    //
    // Per pane rather than over the whole view, because the tab *does* change:
    // an untitled tab is named for the terminal it is showing.
    const keyboardInFirst = drawn(terminalID("t1"));
    const keyboardInSecond = drawn(terminalID("t2"));

    expect(paneMarkup(keyboardInSecond, "zsh")).toBe(paneMarkup(keyboardInFirst, "zsh"));
    expect(paneMarkup(keyboardInSecond, "bash")).toBe(paneMarkup(keyboardInFirst, "bash"));
    expect(paneMarkup(keyboardInFirst, "zsh")).not.toContain("AccentColor");
  });

  test("a session the mirror does not have says so", () => {
    const environment = fakeEnvironment({ sessions: [] });

    expect(renderDetail(environment, "ghost")).toContain("Session not found");
  });

  test("a session with no terminals has no tab strip and says why", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });

    const markup = renderDetail(environment, "s");

    expect(markup).toContain("No terminals in this session");
    expect(markup).not.toContain('role="tablist"');
  });
});

/** Renders the substrate it was given, so a missing announcement is visible. */
function Substrate(): ReactElement {
  return <span data-substrate={String(useSurface())} />;
}

describe("ContentCard", () => {
  test("the card is a step above the window, and says so to what it holds", () => {
    // Two claims, and the second is the one that used to be missing. The card
    // painted level 2 as a class string while still *reporting* level 1, so a
    // menu opened over it computed `1 + 2` and landed on `--surface-3` when it
    // should have been on 4 — in dark appearance, a menu the same colour as the
    // card it floats above.
    const markup = renderToStaticMarkup(
      <ContentCard>
        <Substrate />
      </ContentCard>,
    );

    expect(markup).toContain("bg-surface-2");
    expect(markup).toContain("shadow-surface-2");
    expect(markup).toContain('data-substrate="2"');
  });

  test("a surface inside the card climbs from the card, and stops at the top", () => {
    // What `offset` buys over a hardcoded level: the same dialog is level 5 on
    // the page and level 6 inside a card, and nothing can ask for a token that
    // does not exist. The clamp is the reason a deeply nested surface degrades
    // to "as near as it gets" rather than to transparent.
    const markup = renderToStaticMarkup(
      <ContentCard>
        <Elevated offset={4}>
          <Elevated offset={4}>
            <Substrate />
          </Elevated>
        </Elevated>
      </ContentCard>,
    );

    expect(markup).toContain("bg-surface-6");
    expect(markup).toContain("bg-surface-8");
    expect(markup).toContain('data-substrate="8"');
  });
});

describe("shouldStartOnAttach", () => {
  const configured = terminal("t1");
  const automatic = { ...configured, startsAutomatically: true };

  test("a session just created here starts its shell on the first attach", () => {
    expect(shouldStartOnAttach(automatic, undefined)).toBe(true);
    expect(shouldStartOnAttach(automatic, { kind: "idle" })).toBe(true);
  });

  test("a restored terminal spawns nothing: relaunching the app is not a start", () => {
    expect(shouldStartOnAttach(configured, undefined)).toBe(false);
  });

  test("a terminal that is running, or has finished, is left alone", () => {
    expect(shouldStartOnAttach(automatic, { kind: "running" })).toBe(false);
    expect(shouldStartOnAttach(automatic, { kind: "exited", code: 0 })).toBe(false);
    expect(shouldStartOnAttach(automatic, { kind: "failed", message: "no such" })).toBe(false);
    expect(shouldStartOnAttach(undefined, undefined)).toBe(false);
  });
});

describe("useClientEnvironment", () => {
  test("a view rendered outside the provider says what is missing", () => {
    expect(() => renderToStaticMarkup(<AppSidebar dispatch={ignoreCommand} />)).toThrow(
      /ClientEnvironmentProvider/,
    );
  });
});
