import { describe, expect, test } from "bun:test";

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
  singleTerminalLayout,
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
import { renderToStaticMarkup } from "react-dom/server";

import { ClientEnvironmentProvider, type ClientEnvironment } from "./client-environment.tsx";
import {
  resolveLocalLayout,
  withFocusedTab,
  withFocusedTerminal,
  withFraction,
  type LocalLayoutEntry,
  type PanePath,
} from "./layout-edits.ts";
import {
  MainWindow,
  Sidebar,
  SessionDetail,
  attachPane,
  shouldStartOnAttach,
} from "./main-window.tsx";
import { sessionStatus, sidebarRows } from "./sidebar-model.ts";
import {
  inertNativeShell,
  memorySettingsStore,
  neverCommands,
  recordingService,
} from "./test-fakes.ts";
import { createViewState } from "./view-state.ts";

// ---------------------------------------------------------------------------
// Values. Built here rather than imported: @janela/client's fakes are not
// exported, and a client-side view has no business reaching into a daemon
// package for a fixture.
// ---------------------------------------------------------------------------

const AT = instant("2026-01-01T00:00:00.000Z");

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

describe("Sidebar markup", () => {
  test("a session needing attention says so in its name", () => {
    const withAttention = session("fix/pty", { terminals: [terminal("t1")] });
    const environment = fakeEnvironment({
      sessions: [withAttention],
      states: { [terminalID("t1")]: { kind: "needsAttention" } },
    });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <Sidebar />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain('aria-label="fix/pty — needs attention"');
    expect(markup).toContain("bg-attention");
  });

  test("project rows are disclosures and the selected session is current", () => {
    const member = session("main", { project: "p" });
    const environment = fakeEnvironment({
      projects: [project("p", true)],
      sessions: [member],
      selection: sessionID("main"),
    });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <Sidebar />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-current="true"');
  });
});

describe("MainWindow markup", () => {
  test("no selection renders the empty state, not a detail view", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("No session selected");
    expect(markup).not.toContain('role="tablist"');
  });

  test("an open sheet renders as a labelled dialog over the window", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    environment.view.openSheet({ kind: "jumpList" });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <MainWindow />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain('aria-label="Go to Session"');
    expect(markup).toContain("<dialog");
  });
});

describe("SessionDetail markup", () => {
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

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <SessionDetail sessionID={sessionID("s")} />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("zsh");
    expect(markup).toContain('aria-label="Terminal: zsh — running"');
    // The one creation affordance in the window, and the same action as ⌘T.
    expect(markup).toContain('aria-label="New Terminal"');
  });

  test("a session the mirror does not have says so", () => {
    const environment = fakeEnvironment({ sessions: [] });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <SessionDetail sessionID={sessionID("ghost")} />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("Session not found");
  });

  test("a session with no terminals has no tab strip and says why", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });

    const markup = renderToStaticMarkup(
      <ClientEnvironmentProvider environment={environment}>
        <SessionDetail sessionID={sessionID("s")} />
      </ClientEnvironmentProvider>,
    );

    expect(markup).toContain("No terminals in this session");
    expect(markup).not.toContain('role="tablist"');
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
    expect(() => renderToStaticMarkup(<Sidebar />)).toThrow(/ClientEnvironmentProvider/);
  });
});
