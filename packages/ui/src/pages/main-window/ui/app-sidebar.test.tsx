import { describe, expect, test } from "bun:test";

import { instant, type ForgeOverview, type ForgeState } from "@janela/core";
import { SidebarProvider } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ClientEnvironmentProvider,
  NO_WINDOW_CONTROLS,
  type ClientEnvironment,
} from "../../../shared/model/index.ts";
import {
  WINDOW_CONTROLS_ROOM,
  WINDOW_DRAG_REGION,
  WINDOW_GUTTER_REGION,
} from "../../../shared/ui/index.ts";
import type { ForgeOverviewStore } from "../model/forge-overview.ts";
import { project, session, sessionID, terminal, terminalID } from "../model/session-fixture.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { ForgeOverviewProvider } from "./forge-overview-context.tsx";
import { fakeEnvironment, ignoreCommand } from "./window-fixture.ts";

const OPEN_PULL_REQUEST = {
  host: "gitHub",
  pullRequest: {
    number: 42,
    title: "the inbox, at last",
    state: "open",
    isDraft: false,
    url: "https://github.com/suiramdev/janela/pull/42",
  },
  checks: "passing",
  refreshedAt: instant("2026-09-22T15:00:00Z"),
} as const satisfies ForgeState;

function loadedStore(overview: ForgeOverview): ForgeOverviewStore {
  return {
    state: { kind: "loaded", overview, receivedAt: 0 },
    refresh: () => Promise.resolve(),
    subscribe: () => () => {},
  };
}

function sessionsOnly(markup: string): string {
  return markup.slice(markup.indexOf(">Sessions<"));
}

function renderSidebar(
  environment: ClientEnvironment,
  store: ForgeOverviewStore = loadedStore({ repositories: [], sessions: [] }),
): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <ForgeOverviewProvider store={store}>
        <SidebarProvider>
          <AppSidebar dispatch={ignoreCommand} />
        </SidebarProvider>
      </ForgeOverviewProvider>
    </ClientEnvironmentProvider>,
  );
}

describe("AppSidebar markup", () => {
  test("a session with an unread completion says so in its name, and flashes blue", () => {
    const shipped = session("feat/hooks", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [shipped],
      states: {
        [terminalID("t1")]: {
          kind: "needsAttention",
          activity: { kind: "finished", outcome: "completed" },
        },
      },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="feat/hooks — unread"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-attention");
    expect(markup).toContain("dmx-ripple-echo");
  });

  test("a session whose agent is mid-turn is running, and spins muted for it", () => {
    const midTurn = session("feat/spinner", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [midTurn],
      states: { [terminalID("t1")]: { kind: "running", activity: { kind: "working" } } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="feat/spinner — running"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-muted-foreground");
  });

  test("a session that stopped with an error is red, and does not move", () => {
    const broken = session("fix/build", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [broken],
      states: { [terminalID("t1")]: { kind: "exited", code: 1 } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="fix/build — stopped with an error"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-failure");
    expect(markup).not.toContain("dmx-ripple-echo");
  });

  test("every status paints the same glyph box, so the label never shifts", () => {
    const environment = fakeEnvironment({
      sessions: [
        session("shipped", { terminals: [terminal("t1")] }),
        session("broken", { terminals: [terminal("t2")] }),
        session("busy", { terminals: [terminal("t3")] }),
        session("asleep", { terminals: [terminal("t4")] }),
      ],
      states: {
        [terminalID("t1")]: { kind: "needsAttention" },
        [terminalID("t2")]: { kind: "exited", code: 1 },
        [terminalID("t3")]: { kind: "running", activity: { kind: "working" } },
        [terminalID("t4")]: { kind: "idle" },
      },
    });

    const boxes = [
      ...sessionsOnly(renderSidebar(environment)).matchAll(
        /<div role="status"[^>]*style="([^"]*)"/gu,
      ),
    ].map((match) => match[1]);

    expect(boxes).toHaveLength(4);
    expect(new Set(boxes).size).toBe(1);
    expect(boxes[0]).toContain("min-width:16px");
    expect(boxes[0]).toContain("width:16px");
  });

  test("a session with nothing pending paints no indicator, but keeps the column", () => {
    const shell = session("chore/logs", { terminals: [terminal("t1")] });
    const seen = session("chore/notes", { terminals: [terminal("t2")] });

    const environment = fakeEnvironment({
      sessions: [shell, seen],
      states: {
        [terminalID("t1")]: { kind: "running" },
        [terminalID("t2")]: {
          kind: "running",
          activity: { kind: "finished", outcome: "completed" },
        },
      },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="chore/logs — idle"');
    expect(markup).toContain('aria-label="chore/notes — idle"');
    expect(markup).toContain("invisible");
    expect(markup).not.toContain("text-attention");
    expect(markup).not.toContain("text-failure");
  });

  test("a project is a parent row whose sessions live in a sub-menu, closed or open", () => {
    const inside = session("member", { project: "p", terminals: [terminal("t1")] });

    const closed = renderSidebar(
      fakeEnvironment({ projects: [project("p", false)], sessions: [inside] }),
    );

    const open = renderSidebar(
      fakeEnvironment({ projects: [project("p", true)], sessions: [inside] }),
    );

    for (const markup of [closed, open]) {
      expect(markup).toContain("group/parent-row");
      expect(markup.indexOf('data-sidebar="menu-button"')).toBeLessThan(
        markup.indexOf('data-sidebar="menu-sub"'),
      );

      expect(markup).toMatch(
        /<button[^>]*aria-label="member — idle"[^>]*data-sidebar="menu-sub-button"/u,
      );
    }

    expect(closed).toMatch(/data-sidebar="menu-sub" data-state="closed" aria-hidden="true"/u);
    expect(closed).toContain('aria-expanded="false"');
    expect(open).toMatch(/data-sidebar="menu-sub" data-state="open"/u);
    expect(open).toContain('aria-expanded="true"');
  });

  test("the Sessions section is a collapsible group with its controls in the header cluster", () => {
    const markup = renderSidebar(fakeEnvironment({ projects: [project("p", false)] }));
    const cluster = markup.indexOf('data-sidebar="group-actions"');

    expect(markup).toMatch(/data-sidebar="group" data-state="open"/u);
    expect(markup).toMatch(/<button[^>]*data-sidebar="group-label"/u);
    expect(cluster).toBeGreaterThan(-1);
    expect(markup.indexOf('aria-label="Filter: All Sessions"')).toBeGreaterThan(cluster);
    expect(markup.indexOf('aria-label="New Project"')).toBeGreaterThan(cluster);
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

    expect(markup).toContain('aria-label="Search"');
    expect(markup).toContain("Toggle Sidebar");
    expect(markup).toContain("New Session");
    expect(markup).toContain('aria-label="New Project"');
    expect(markup).toContain('aria-label="Filter: All Sessions"');
    expect(markup.indexOf('data-sidebar="header"')).toBeLessThan(
      markup.indexOf('data-sidebar="content"'),
    );

    expect(markup).toContain('data-slot="scroll-area-viewport"');
  });

  test("the window controls get the head of the header row, and fullscreen takes it back", () => {
    const overlaid = renderSidebar(fakeEnvironment({}));
    const fullscreen = renderSidebar(fakeEnvironment({ windowControls: NO_WINDOW_CONTROLS }));

    expect(overlaid.indexOf(WINDOW_CONTROLS_ROOM)).toBeGreaterThan(-1);
    expect(overlaid.indexOf(WINDOW_CONTROLS_ROOM)).toBeLessThan(
      overlaid.indexOf('aria-label="Search"'),
    );

    expect(fullscreen).not.toContain(WINDOW_CONTROLS_ROOM);
  });

  test("the header row is the band that drags the window, in both states", () => {
    const region = `data-tauri-drag-region="${WINDOW_DRAG_REGION}"`;
    const gutter = `data-tauri-drag-region="${WINDOW_GUTTER_REGION}"`;

    for (const markup of [
      renderSidebar(fakeEnvironment({})),
      renderSidebar(fakeEnvironment({ windowControls: NO_WINDOW_CONTROLS })),
    ]) {
      expect(markup.indexOf(region)).toBeGreaterThan(-1);
      expect(markup.indexOf(region)).toBeLessThan(markup.indexOf('aria-label="Search"'));
      expect(markup).toMatch(new RegExp(`data-sidebar="header"[^>]*${gutter}`, "u"));
    }
  });

  test("the Inbox row is live and carries a spinner, not a count, while a session needs you", () => {
    const waiting = session("feat/hooks", { terminals: [terminal("t1")] });
    const markup = renderSidebar(
      fakeEnvironment({
        sessions: [waiting],
        states: { [terminalID("t1")]: { kind: "needsAttention" } },
      }),
    );

    expect(markup).not.toContain("Planned");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<[^>]*>[^<]*Inbox/u);
    expect(markup).toContain(">A session needs you<");
    expect(markup).not.toMatch(/data-sidebar="menu-badge"[^>]*>1</u);

    const quiet = renderSidebar(fakeEnvironment({ sessions: [waiting] }));

    expect(quiet).not.toContain("needs you");
  });

  test("a session with a pull request shows its number, state and link, not its branch or title", () => {
    const member = session("member", { project: "p" });
    const environment = fakeEnvironment({ projects: [project("p", true)], sessions: [member] });
    const merged = {
      ...OPEN_PULL_REQUEST,
      pullRequest: { ...OPEN_PULL_REQUEST.pullRequest, state: "merged" as const },
    };

    const store = loadedStore({
      repositories: [],
      sessions: [{ sessionID: member.id, branch: "feat/inbox", forge: merged }],
    });

    const markup = renderSidebar(environment, store);

    expect(markup).toContain("#42");
    expect(markup).toContain("Merged");
    expect(markup).toContain('aria-label="Open pull request #42 on GitHub"');
    expect(markup).not.toContain(">feat/inbox<");
    expect(markup).not.toContain("the inbox, at last");
  });

  test("a session with only a branch shows the branch, and no link", () => {
    const member = session("member", { project: "p" });
    const environment = fakeEnvironment({ projects: [project("p", true)], sessions: [member] });
    const store = loadedStore({
      repositories: [],
      sessions: [{ sessionID: member.id, branch: "feat/inbox" }],
    });

    const markup = renderSidebar(environment, store);

    expect(markup).toContain(">feat/inbox<");
    expect(markup).not.toContain("Open pull request");
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

    expect(markup.split('data-sidebar="group-label"')).toHaveLength(2);

    const label = markup.indexOf('data-sidebar="group-label"');

    expect(markup.slice(label, markup.indexOf("loose"))).toContain("Sessions");
    expect(markup).not.toContain(">Projects<");
    expect(markup.indexOf("loose")).toBeLessThan(markup.indexOf("janela"));
    expect(markup.indexOf("janela")).toBeLessThan(markup.indexOf("inside"));
  });

  test("the theme button sits after Settings and names the held theme", () => {
    const environment = fakeEnvironment({});
    environment.view.setSettings({ ...environment.view.settings, theme: "dark" });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="Theme: Dark"');
    expect(markup.indexOf(">Settings<")).toBeLessThan(markup.indexOf('aria-label="Theme: Dark"'));
  });

  test("a browser client has no theme button: nothing there can hold one", () => {
    const markup = renderSidebar({ ...fakeEnvironment({}), local: undefined });

    expect(markup).toContain(">Settings<");
    expect(markup).not.toContain('aria-label="Theme:');
  });
});
