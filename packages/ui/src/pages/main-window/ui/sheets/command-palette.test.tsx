import { describe, expect, test } from "bun:test";

import type { ProjectID, SessionID, TerminalID, TerminalState } from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { COMMANDS, availableCommands } from "../../../../shared/config/index.ts";
import {
  fakeProject,
  fakeSession,
  fakeTerminal,
  states,
} from "../../../../shared/lib/test-fakes/index.ts";
import { CommandPalette, rankedCommands, rankedSessionRows } from "./command-palette.tsx";

const noop = (): void => {};

const projectID = (raw: string): ProjectID => raw as ProjectID;

const sessionID = (raw: string): SessionID => raw as SessionID;

const terminalID = (raw: string): TerminalID => raw as TerminalID;

const NO_STATES: Readonly<Record<TerminalID, TerminalState>> = {};

const janela = fakeProject({ id: projectID("p-janela"), name: "janela" });

const pty = fakeSession({ id: sessionID("s-pty"), name: "fix/pty", projectID: janela.id });

const scratch = fakeSession({ id: sessionID("s-scratch"), name: "scratch" });

const PROJECTS = [janela];

const SESSIONS = [pty];

describe("rankedCommands", () => {
  test("an empty query is the whole table, in its order", () => {
    expect(rankedCommands("").map((item) => item.value)).toEqual(
      COMMANDS.map((command) => command.id),
    );
  });

  test("every row of the table is reachable by its own title", () => {
    for (const command of COMMANDS) {
      expect(rankedCommands(command.title).map((item) => item.value)).toContain(command.id);
    }
  });

  test("a row's chord travels with it, as caps the menu can split", () => {
    const split = rankedCommands("Split Vertically")[0];

    expect(split?.value).toBe("splitRight");
    expect(split?.shortcut).toBe("⌘+D");
  });

  test("commands with no chord carry none", () => {
    const reveal = rankedCommands("Reveal in Finder")[0];

    expect(reveal?.value).toBe("revealInFinder");
    expect(reveal?.shortcut).toBeUndefined();
  });

  test("a client without a local shell is offered no host-only command", () => {
    const offered = rankedCommands("", availableCommands(false)).map((item) => item.value);

    expect(offered).not.toContain("revealInFinder");
    expect(offered).not.toContain("openInTerminal");
    expect(offered).toContain("addProject");
    expect(offered).toContain("openFolder");
    expect(offered).toContain("newSession");
  });
});

describe("rankedSessionRows", () => {
  test("an empty query lists no sessions: the palette opens on the commands", () => {
    expect(rankedSessionRows("", [janela], [pty, scratch], NO_STATES)).toEqual([]);
  });

  test("a session is found by its name, and by its project's", () => {
    expect(rankedSessionRows("fpty", [janela], [pty, scratch], NO_STATES)[0]?.label).toBe(
      "fix/pty",
    );
    expect(rankedSessionRows("janela", [janela], [pty, scratch], NO_STATES)[0]?.label).toBe(
      "fix/pty",
    );
  });

  test("a row says where the session lives and what it is doing", () => {
    const running = fakeSession({
      id: sessionID("s-run"),
      name: "run",
      projectID: janela.id,
      terminals: [fakeTerminal({ id: terminalID("t-run") })],
    });

    const row = rankedSessionRows(
      "run",
      [janela],
      [running],
      states([terminalID("t-run"), { kind: "running" }]),
    )[0];

    expect(row?.description).toBe("janela");
    expect(row?.status).toBe("running");
  });

  test("a standalone session says so rather than naming an empty project", () => {
    expect(rankedSessionRows("scratch", [janela], [scratch], NO_STATES)[0]?.description).toBe(
      "Standalone",
    );
  });

  test("a session row can never be mistaken for a command", () => {
    const collision = fakeSession({ id: sessionID("s-next"), name: "nextTab" });

    const row = rankedSessionRows("nextTab", [], [collision], NO_STATES)[0];

    expect(row?.value).not.toBe("nextTab");
  });
});

describe("CommandPalette markup", () => {
  const drawn = (): string =>
    renderToStaticMarkup(
      <CommandPalette
        projects={PROJECTS}
        sessions={SESSIONS}
        terminalStates={NO_STATES}
        commands={COMMANDS}
        onPick={noop}
        onPickSession={noop}
        onCancel={noop}
      />,
    );

  test("a command's accelerator is drawn as one keycap per glyph", () => {
    const markup = drawn();

    expect(markup).toContain("Go to Session…");
    expect(markup).not.toContain(">⌘⇧O<");

    for (const cap of [">⌘<", ">⇧<", ">O<"]) expect(markup).toContain(cap);
  });

  test("the rows are filed under headings, not mixed into one list", () => {
    const markup = drawn();

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain(">Commands<");
    expect(markup).not.toContain(">Sessions<");
  });

  test("the sheet around the menu is the menu's shell, so Escape has a hint", () => {
    const markup = drawn();

    expect(markup).toContain(">Close<");
    expect(markup).toContain(">Esc<");
  });
});
