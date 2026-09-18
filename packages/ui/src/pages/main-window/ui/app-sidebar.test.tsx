import { describe, expect, test } from "bun:test";

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
import { project, session, sessionID, terminal, terminalID } from "../model/session-fixture.ts";
import { AppSidebar } from "./app-sidebar.tsx";
import { fakeEnvironment, ignoreCommand } from "./window-fixture.ts";

function renderSidebar(environment: ClientEnvironment): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <SidebarProvider>
        <AppSidebar dispatch={ignoreCommand} />
      </SidebarProvider>
    </ClientEnvironmentProvider>,
  );
}

describe("AppSidebar markup", () => {
  test("a session needing attention says so in its name, and spins for it", () => {
    const withAttention = session("fix/pty", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [withAttention],
      states: { [terminalID("t1")]: { kind: "needsAttention" } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="fix/pty — needs attention"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-attention");
    expect(markup).toContain("dmx-ripple-echo");
  });

  test("a session whose agent is mid-turn is working, and spins muted for it", () => {
    const midTurn = session("feat/spinner", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [midTurn],
      states: { [terminalID("t1")]: { kind: "running", progress: { kind: "indeterminate" } } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="feat/spinner — working"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-muted-foreground");
  });

  test("a failed session spins like attention does, in the failure colour", () => {
    const broken = session("fix/build", { terminals: [terminal("t1")] });

    const environment = fakeEnvironment({
      sessions: [broken],
      states: { [terminalID("t1")]: { kind: "exited", code: 1 } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="fix/build — failed"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-failure");
  });

  test("a session whose agent said it finished is done, in green, and does not spin", () => {
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

    expect(markup).toContain('aria-label="feat/hooks — finished"');
    expect(markup).toContain("dmx-matrix-3");
    expect(markup).toContain("text-success");
    expect(markup).not.toContain("dmx-ripple-echo");
  });

  test("every status paints the same glyph box, so the label never shifts", () => {
    const environment = fakeEnvironment({
      sessions: [
        session("waiting", { terminals: [terminal("t1")] }),
        session("broken", { terminals: [terminal("t2")] }),
        session("shipped", { terminals: [terminal("t3")] }),
        session("busy", { terminals: [terminal("t4")] }),
        session("alive", { terminals: [terminal("t5")] }),
        session("asleep", { terminals: [terminal("t6")] }),
      ],
      states: {
        [terminalID("t1")]: { kind: "needsAttention" },
        [terminalID("t2")]: { kind: "exited", code: 1 },
        [terminalID("t3")]: {
          kind: "needsAttention",
          activity: { kind: "finished", outcome: "completed" },
        },
        [terminalID("t4")]: { kind: "running", progress: { kind: "indeterminate" } },
        [terminalID("t5")]: { kind: "running" },
        [terminalID("t6")]: { kind: "idle" },
      },
    });

    const boxes = [
      ...renderSidebar(environment).matchAll(/<div role="status"[^>]*style="([^"]*)"/gu),
    ].map((match) => match[1]);

    expect(boxes).toHaveLength(6);
    expect(new Set(boxes).size).toBe(1);
    expect(boxes[0]).toContain("min-width:16px");
    expect(boxes[0]).toContain("width:16px");
  });

  test("a session with nothing pending paints no indicator, but keeps the column", () => {
    const running = session("chore/logs", { terminals: [terminal("t1")] });
    const idle = session("chore/notes", { terminals: [terminal("t2")] });

    const environment = fakeEnvironment({
      sessions: [running, idle],
      states: { [terminalID("t1")]: { kind: "running" }, [terminalID("t2")]: { kind: "idle" } },
    });

    const markup = renderSidebar(environment);

    expect(markup).toContain('aria-label="chore/logs — running"');
    expect(markup).toContain('aria-label="chore/notes — idle"');
    expect(markup).toContain("invisible");
    expect(markup).not.toContain("text-attention");
    expect(markup).not.toContain("text-failure");
    expect(markup).not.toContain("text-success");
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

    expect(markup.split('data-sidebar="group-label"')).toHaveLength(2);

    const label = markup.indexOf('data-sidebar="group-label"');

    expect(markup.slice(label, markup.indexOf("loose"))).toContain("Sessions");
    expect(markup).not.toContain(">Projects<");
    expect(markup.indexOf("loose")).toBeLessThan(markup.indexOf("janela"));
    expect(markup.indexOf("janela")).toBeLessThan(markup.indexOf("inside"));
  });
});
