import { describe, expect, test } from "bun:test";

import { singleTerminalLayout } from "@janela/core";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { environmentOver } from "../../../shared/lib/test-fakes/index.ts";
import {
  ClientEnvironmentProvider,
  type ClientEnvironment,
  type SettingsRoute,
} from "../../../shared/model/index.ts";
import { WINDOW_GUTTER_REGION } from "../../../shared/ui/index.ts";
import { projectID, session, terminal, terminalID } from "../model/session-fixture.ts";
import { MainWindow } from "./main-window.tsx";
import { fakeEnvironment } from "./window-fixture.ts";

const stubSettings = (route: SettingsRoute): ReactElement => (
  <div data-slot="settings-stub" data-route={route.kind} />
);

function draw(environment: ClientEnvironment): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <MainWindow renderSettings={stubSettings} />
    </ClientEnvironmentProvider>,
  );
}

describe("MainWindow markup", () => {
  test("no selection renders the welcome screen, not a detail view", () => {
    const markup = draw(fakeEnvironment({ sessions: [session("s")] }));

    expect(markup).toContain("No session open");
    expect(markup).toContain("New Session");
    expect(markup).toContain("Add Project");
    expect(markup).not.toContain('role="tablist"');
  });

  test("an open sheet is view state the window keeps rendering behind", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    environment.view.openSheet({ kind: "jumpList" });

    expect(environment.view.sheet).toEqual({ kind: "jumpList" });

    const markup = draw(environment);

    expect(markup).toContain('data-sidebar="content"');
    expect(markup).toContain('aria-label="Filter: All Sessions"');
  });

  test("the first frame after a relaunch shows the surviving session, not an empty pane", () => {
    const survivor = session("agent", {
      terminals: [terminal("t1", "claude")],
      layout: singleTerminalLayout(terminalID("t1")),
    });

    const markup = draw(
      environmentOver({
        sessions: [survivor],
        terminalStates: { [terminalID("t1")]: { kind: "running" } },
      }),
    );

    expect(markup).not.toContain("No session open");
    expect(markup).toContain('aria-label="Terminal: claude — running"');
    expect(markup).toContain('aria-current="true"');
  });

  test("an empty mirror still renders the empty state: there is nothing to select", () => {
    expect(draw(environmentOver({ sessions: [] }))).toContain("No session open");
  });

  test("the window's own chrome drags it, not only the rows inside it", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    const workspace = draw(environment);
    environment.view.showSettings({ kind: "tab", tab: "appearance" });
    const settings = draw(environment);
    const gutter = `data-tauri-drag-region="${WINDOW_GUTTER_REGION}"`;

    for (const markup of [workspace, settings]) {
      expect(markup).toMatch(new RegExp(`data-slot="sidebar-wrapper"[^>]*${gutter}`, "u"));
    }

    expect(workspace).toMatch(new RegExp(`data-slot="sidebar-inset"[^>]*${gutter}`, "u"));
  });
});

describe("the settings screen's slot", () => {
  test("nothing renders it while the window is on the workspace", () => {
    const markup = draw(fakeEnvironment({ sessions: [session("s")] }));

    expect(markup).not.toContain('data-slot="settings-stub"');
    expect(markup).toContain('data-sidebar="content"');
  });

  test("showing settings replaces the workspace with the slot, route and all", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    environment.view.showSettings({ kind: "project", projectID: projectID("janela") });

    const markup = draw(environment);

    expect(markup).toContain('data-slot="settings-stub"');
    expect(markup).toContain('data-route="project"');
    expect(markup).not.toContain("No session open");
    expect(markup).not.toContain('aria-label="Filter: All Sessions"');
  });

  test("the frame around the slot is the frame around the workspace", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });
    environment.view.openSheet({ kind: "commands" });
    const workspace = draw(environment);
    environment.view.showSettings({ kind: "tab", tab: "appearance" });
    const settings = draw(environment);

    expect(settings).toContain('data-slot="settings-stub"');

    for (const markup of [workspace, settings]) {
      expect(markup).toContain('class="contents"');
      expect(markup).toContain('data-slot="sidebar-wrapper"');
    }

    expect(environment.view.sheet).toEqual({ kind: "commands" });
  });
});
