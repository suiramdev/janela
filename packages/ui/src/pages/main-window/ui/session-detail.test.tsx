import { describe, expect, test } from "bun:test";

import type { TerminalID } from "@janela/core";
import { singleTerminalLayout } from "@janela/core";
import { SidebarProvider, SizeProvider, sizeMap, type SizeVariant } from "@janela/design";
import { renderToStaticMarkup } from "react-dom/server";

import { ClientEnvironmentProvider, type ClientEnvironment } from "../../../shared/model/index.ts";
import {
  session,
  sessionID,
  splitFocusing,
  terminal,
  terminalID,
} from "../model/session-fixture.ts";
import { SessionDetail } from "./session-detail.tsx";
import { fakeEnvironment } from "./window-fixture.ts";

function paneMarkup(markup: string, title: string): string {
  const at = markup.indexOf(`aria-label="Terminal: ${title} — `);

  expect(at).toBeGreaterThan(-1);

  const opening = markup.lastIndexOf('<div data-slot="terminal-pane"', at);

  expect(opening).toBeGreaterThan(-1);

  return markup.slice(opening, at);
}

function classOf(markup: string, marker: string): string {
  const at = markup.indexOf(marker);

  expect(at).toBeGreaterThan(-1);

  const opening = markup.lastIndexOf("<", at);
  const closing = markup.indexOf(">", at);
  const match = /class="([^"]*)"/.exec(markup.slice(opening, closing));

  expect(match).not.toBeNull();

  return match?.[1] ?? "";
}

function renderDetail(environment: ClientEnvironment, id: string): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <SidebarProvider>
        <SessionDetail sessionID={sessionID(id)} />
      </SidebarProvider>
    </ClientEnvironmentProvider>,
  );
}

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

    const markup = renderDetail(environment, "s");

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain("zsh");
    expect(markup).toContain('aria-label="Terminal: zsh — running"');
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

    expect(markup).toContain('aria-label="Close tab: bash"');
    expect(markup).toContain('aria-label="Close terminal: zsh"');
    expect(markup).toContain('aria-label="Close terminal: bash"');
  });

  test("each terminal's bar is a drag handle, and nothing is a drop target until a drag begins", () => {
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

    expect(paneMarkup(markup, "zsh")).toContain('draggable="true"');
    expect(paneMarkup(markup, "bash")).toContain('draggable="true"');
    expect(markup).not.toContain("data-drop-edge");
    expect(markup).not.toContain('data-slot="new-tab-drop"');
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

    for (const step of ["compact", "default"] as const) {
      const markup = drawn(step);
      const other = step === "compact" ? "default" : "compact";

      expect(markup).toContain(sizeMap[step].control);
      expect(markup).not.toContain(sizeMap[other].control);
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

  test("a session with no terminals has no tab strip, and offers to start one", () => {
    const environment = fakeEnvironment({ sessions: [session("s")] });

    const markup = renderDetail(environment, "s");

    expect(markup).toContain("No terminals in this session");
    expect(markup).toContain("New Terminal");
    expect(markup).not.toContain('role="tablist"');
  });
});
