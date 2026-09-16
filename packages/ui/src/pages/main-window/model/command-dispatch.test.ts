import { describe, expect, test } from "bun:test";

import type { ClientRequest, ProjectStore, SessionStore } from "@janela/client";
import {
  absolutePath,
  instant,
  type Project,
  type Session,
  type SessionID,
  type TerminalID,
  type TerminalState,
} from "@janela/core";

import { COMMANDS } from "../../../shared/config/index.ts";
import {
  type RecordingConfirmations,
  type RecordingNativeShell,
  fakeProfile,
  fakeProject,
  fakeSession,
  fakeSurfaceHandle,
  fakeTerminal,
  inertNativeShell,
  recordingConfirmations,
  recordingService,
} from "../../../shared/lib/test-fakes/index.ts";
import {
  type ConfirmationKey,
  type ConfirmationRequest,
  type ViewState,
  createViewState,
} from "../../../shared/model/index.ts";
import {
  type CommandTarget,
  closeTerminals,
  createCommandDispatch,
  createSessionAndSelect,
  sessionOrder,
} from "./command-dispatch.ts";

interface Harness {
  readonly target: CommandTarget;
  readonly view: ViewState;
  readonly sessions: SessionStore;
  readonly sent: ClientRequest[];
  readonly native: RecordingNativeShell;
  readonly confirmations: RecordingConfirmations;
  appears: Session | undefined;
}

const AT = instant("2026-01-01T00:00:00.000Z");

function harness(options: {
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly selection?: SessionID;
  readonly states?: Readonly<Record<TerminalID, TerminalState>>;
  readonly profiles?: readonly ReturnType<typeof fakeProfile>[];
  readonly confirms?: boolean;
  readonly silenced?: readonly ConfirmationKey[];
  readonly picks?: string;
  readonly local?: false;
}): Harness {
  let sessions = options.sessions ?? [];
  let selection = options.selection;
  const sent: ClientRequest[] = [];

  const projectStore: ProjectStore = {
    projects: options.projects ?? [],
    find: (id) => (options.projects ?? []).find((project) => project.id === id),
    subscribe: () => () => {},
  };

  const sessionStore: SessionStore = {
    get sessions(): readonly Session[] {
      return sessions;
    },
    get selection(): SessionID | undefined {
      return selection;
    },
    set selection(next: SessionID | undefined) {
      selection = next;
    },
    terminalStates: options.states ?? {},
    launchProfiles: options.profiles ?? [],
    launchProfileAvailability: {},
    inProject: () => [],
    standaloneSessions: sessions,
    isRunning: () => false,
    subscribe: () => () => {},
  };

  let appearing: Session | undefined;
  const native = inertNativeShell();

  const recording: RecordingNativeShell = {
    calls: native.calls,
    pickDirectory: async (request) => {
      await native.pickDirectory(request);

      return options.picks === undefined ? undefined : absolutePath(options.picks);
    },
    revealInFinder: native.revealInFinder,
    openInTerminal: native.openInTerminal,
  };

  const view = createViewState(sessionStore);

  const confirmations = recordingConfirmations({
    agrees: options.confirms === true,
    silenced: options.silenced,
  });

  const target: CommandTarget = {
    projects: projectStore,
    sessions: sessionStore,
    view,
    local:
      options.local === false
        ? undefined
        : { native: recording, service: recordingService(), restartDaemon: () => {} },
    confirmations,
    connection: {
      request: (message) => {
        sent.push(message);

        if (message.type === "createSession" && appearing !== undefined) {
          sessions = [...sessions, appearing];
        }

        return Promise.resolve(undefined);
      },
    },
  };

  return {
    target,
    view,
    sessions: sessionStore,
    sent,
    native: recording,
    confirmations,
    get appears(): Session | undefined {
      return appearing;
    },
    set appears(next: Session | undefined) {
      appearing = next;
    },
  };
}

function asking(context: Harness, agrees: boolean) {
  const confirmations = recordingConfirmations({ agrees, silenced: undefined });

  return {
    get messages(): readonly string[] {
      return confirmations.asked.map((request) => request.message);
    },
    get asked(): readonly ConfirmationRequest[] {
      return confirmations.asked;
    },
    target: {
      sessions: context.sessions,
      connection: context.target.connection,
      confirmations,
    },
  };
}

describe("sessionOrder", () => {
  test("standalone sessions first, then each project's, in sidebar order", () => {
    const first = fakeProject({ name: "a" });
    const second = fakeProject({ name: "b" });
    const loose = fakeSession({ name: "loose" });
    const inFirst = fakeSession({ name: "in-a", projectID: first.id });
    const inSecond = fakeSession({ name: "in-b", projectID: second.id });

    const order = sessionOrder([first, second], [inSecond, inFirst, loose]);

    expect(order.map((session) => session.name)).toEqual(["loose", "in-a", "in-b"]);
  });
});

describe("every command", () => {
  test("dispatches without throwing, with nothing selected and nothing connected", async () => {
    const { target } = harness({});
    const dispatch = createCommandDispatch(target);

    for (const command of COMMANDS) {
      // oxlint-disable-next-line no-await-in-loop
      await dispatch(command.id);
    }
  });
});

describe("sheets and screens", () => {
  test("the sheet commands open their own sheet", async () => {
    const session = fakeSession();
    const { target, view } = harness({ sessions: [session], selection: session.id });
    const dispatch = createCommandDispatch(target);

    await dispatch("goToSession");

    expect(view.sheet).toEqual({ kind: "jumpList" });

    await dispatch("showCommands");

    expect(view.sheet).toEqual({ kind: "commands" });

    await dispatch("newSession");

    expect(view.sheet).toEqual({ kind: "newSession" });
  });

  test("Settings is a screen, not a sheet", async () => {
    const { target, view } = harness({});
    await createCommandDispatch(target)("openSettings");

    expect(view.screen).toEqual({ kind: "settings", route: { kind: "tab", tab: "general" } });
    expect(view.sheet).toBeUndefined();
  });

  test("New Terminal asks for a shell directly; there is no picker", async () => {
    const session = fakeSession();
    const context = harness({ sessions: [session], selection: session.id });
    await createCommandDispatch(context.target)("newTerminal");

    expect(context.view.sheet).toBeUndefined();
    expect(context.sent).toEqual([{ type: "createTerminal", sessionID: session.id }]);
  });
});

describe("creation", () => {
  test("New Session in a project opens the branch dialog for that project", async () => {
    const project = fakeProject();
    const session = fakeSession({ projectID: project.id });

    const context = harness({
      projects: [project],
      sessions: [session],
      selection: session.id,
    });

    await createCommandDispatch(context.target)("newSession");

    expect(context.view.sheet).toEqual({ kind: "newSession", projectID: project.id });
    expect(context.sent).toEqual([]);
  });

  test("New Session with nothing selected opens the same dialog on no project", async () => {
    const context = harness({ projects: [fakeProject()] });

    await createCommandDispatch(context.target)("newSession");

    expect(context.view.sheet).toEqual({ kind: "newSession" });
    expect(context.native.calls).toEqual([]);
    expect(context.sent).toEqual([]);
  });

  test("createSessionAndSelect lands the keyboard in the session that appeared", async () => {
    const project = fakeProject();

    const appeared = fakeSession({
      projectID: project.id,
      terminals: [fakeTerminal()],
      createdAt: AT,
    });

    const context = harness({ projects: [project] });
    context.appears = appeared;
    const handle = fakeSurfaceHandle();
    const firstTerminal = appeared.terminals[0];

    if (firstTerminal === undefined) throw new Error("the fixture has no terminal");

    context.view.registerSurface(firstTerminal.id, handle);

    await createSessionAndSelect(context.target, {
      kind: "inProject",
      projectID: project.id,
      branch: "main",
    });

    expect(context.sent).toEqual([
      {
        type: "createSession",
        intent: { kind: "inProject", projectID: project.id, branch: "main" },
      },
    ]);
    expect(context.sessions.selection).toBe(appeared.id);
    expect(handle.calls).toEqual(["focus"]);
  });

  test("a cancelled folder dialog sends nothing", async () => {
    const context = harness({});
    await createCommandDispatch(context.target)("openFolder");

    expect(context.native.calls).toEqual(["pickDirectory:Open Folder"]);
    expect(context.sent).toEqual([]);
  });

  test("a chosen folder becomes a standalone session", async () => {
    const context = harness({ picks: "/tmp/notes" });
    await createCommandDispatch(context.target)("openFolder");

    expect(context.sent).toEqual([
      {
        type: "createSession",
        intent: { kind: "standalone", directory: absolutePath("/tmp/notes") },
      },
    ]);
  });

  test("Add Project hands the daemon a path the user picked", async () => {
    const context = harness({ picks: "/repos/janela" });
    await createCommandDispatch(context.target)("addProject");

    expect(context.native.calls).toEqual(["pickDirectory:Add Project"]);
    expect(context.sent).toEqual([
      { type: "addProject", directory: absolutePath("/repos/janela") },
    ]);
  });
});

describe("splits", () => {
  test("a split names the focused pane and starts a shell, whatever that pane runs", async () => {
    const profile = fakeProfile();
    const terminal = fakeTerminal({ profileID: profile.id });
    const session = fakeSession({ terminals: [terminal] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      profiles: [profile],
    });

    await createCommandDispatch(context.target)("splitRight");
    await createCommandDispatch(context.target)("splitDown");

    expect(context.sent).toEqual([
      {
        type: "createTerminal",
        sessionID: session.id,
        placement: { kind: "split", beside: terminal.id, axis: "horizontal" },
      },
      {
        type: "createTerminal",
        sessionID: session.id,
        placement: { kind: "split", beside: terminal.id, axis: "vertical" },
      },
    ]);
  });
});

describe("closePane", () => {
  test("a running pane is confirmed first, and a refusal sends nothing", async () => {
    const terminal = fakeTerminal({ title: "claude" });
    const session = fakeSession({ terminals: [terminal] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [terminal.id]: { kind: "running" } },
    });

    await createCommandDispatch(context.target)("closePane");

    expect(context.confirmations.titles).toEqual(["Close this pane?"]);
    expect(context.sent).toEqual([]);
  });

  test("the question offers Don't ask again, because it is the repetitive one", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [terminal.id]: { kind: "running" } },
    });

    await createCommandDispatch(context.target)("closePane");

    expect(context.confirmations.asked[0]?.remember).toBe("closeTerminals");
  });

  test("a silenced question closes a running pane without asking", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [terminal.id]: { kind: "running" } },
      silenced: ["closeTerminals"],
    });

    await createCommandDispatch(context.target)("closePane");

    expect(context.confirmations.titles).toEqual([]);
    expect(context.sent).toEqual([{ type: "removeTerminal", terminalID: terminal.id }]);
  });

  test("a confirmed close removes the terminal", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [terminal.id]: { kind: "running" } },
      confirms: true,
    });

    await createCommandDispatch(context.target)("closePane");

    expect(context.sent).toEqual([{ type: "removeTerminal", terminalID: terminal.id }]);
  });

  test("an idle pane closes without asking: there is nothing to lose", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });
    const context = harness({ sessions: [session], selection: session.id });

    await createCommandDispatch(context.target)("closePane");

    expect(context.confirmations.titles).toEqual([]);
    expect(context.sent).toEqual([{ type: "removeTerminal", terminalID: terminal.id }]);
  });
});

describe("closeTerminals", () => {
  test("closing a tab states how many terminals it ends, and ends all of them", async () => {
    const shell = fakeTerminal({ title: "zsh" });
    const agent = fakeTerminal({ title: "claude" });
    const done = fakeTerminal({ title: "bun test" });
    const session = fakeSession({ terminals: [shell, agent, done] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: {
        [shell.id]: { kind: "running" },
        [agent.id]: { kind: "needsAttention" },
        [done.id]: { kind: "exited", code: 0 },
      },
    });

    const asked = asking(context, true);

    await closeTerminals(asked.target, session, [shell.id, agent.id, done.id], "tab");

    expect(asked.messages).toEqual(["2 terminals are still running. Closing the tab ends them."]);
    expect(context.sent).toEqual([
      { type: "removeTerminal", terminalID: shell.id },
      { type: "removeTerminal", terminalID: agent.id },
      { type: "removeTerminal", terminalID: done.id },
    ]);
  });

  test("refusing keeps every terminal in the tab, including the finished ones", async () => {
    const shell = fakeTerminal({ title: "zsh" });
    const done = fakeTerminal();
    const session = fakeSession({ terminals: [shell, done] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [shell.id]: { kind: "running" } },
    });

    const asked = asking(context, false);

    await closeTerminals(asked.target, session, [shell.id, done.id], "tab");

    expect(asked.messages).toEqual(["zsh is still running. Closing the tab ends it."]);
    expect(context.sent).toEqual([]);
  });

  test("a tab of finished terminals closes without a question", async () => {
    const first = fakeTerminal();
    const second = fakeTerminal();
    const session = fakeSession({ terminals: [first, second] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [first.id]: { kind: "exited", code: 130 } },
    });

    await closeTerminals(context.target, session, [first.id, second.id], "tab");

    expect(context.confirmations.titles).toEqual([]);
    expect(context.sent).toEqual([
      { type: "removeTerminal", terminalID: first.id },
      { type: "removeTerminal", terminalID: second.id },
    ]);
  });

  test("closing a run of tabs asks once, about the tabs", async () => {
    const shell = fakeTerminal({ title: "zsh" });
    const agent = fakeTerminal({ title: "claude" });
    const session = fakeSession({ terminals: [shell, agent] });

    const context = harness({
      sessions: [session],
      selection: session.id,
      states: { [shell.id]: { kind: "running" }, [agent.id]: { kind: "running" } },
    });

    const asked = asking(context, true);

    await closeTerminals(asked.target, session, [shell.id, agent.id], "tabs");

    expect(asked.asked).toEqual([
      {
        title: "Close these tabs?",
        message: "2 terminals are still running. Closing the tabs ends them.",
        confirmLabel: "Close Tabs",
        remember: "closeTerminals",
      },
    ]);
  });
});

describe("navigation", () => {
  test("next and previous session wrap in sidebar order", async () => {
    const first = fakeSession({ name: "first" });
    const second = fakeSession({ name: "second" });
    const context = harness({ sessions: [first, second], selection: second.id });
    const dispatch = createCommandDispatch(context.target);

    await dispatch("nextSession");

    expect(context.sessions.selection).toBe(first.id);

    await dispatch("previousSession");

    expect(context.sessions.selection).toBe(second.id);
  });

  test("next and previous tab move the local focus, wrapping", async () => {
    const [a, b] = [fakeTerminal(), fakeTerminal()];

    const session = fakeSession({
      terminals: [a, b],
      layout: {
        tabs: [
          { root: { kind: "terminal", id: a.id }, focusedTerminalID: a.id },
          { root: { kind: "terminal", id: b.id }, focusedTerminalID: b.id },
        ],
        focusedTabIndex: 0,
      },
    });

    const context = harness({ sessions: [session], selection: session.id });
    const dispatch = createCommandDispatch(context.target);

    await dispatch("nextTab");

    expect(context.view.layouts.get(session.id)?.local.focusedTabIndex).toBe(1);

    await dispatch("nextTab");

    expect(context.view.layouts.get(session.id)?.local.focusedTabIndex).toBe(0);

    await dispatch("previousTab");

    expect(context.view.layouts.get(session.id)?.local.focusedTabIndex).toBe(1);
  });

  test("pane focus walks the split tree", async () => {
    const [a, b] = [fakeTerminal(), fakeTerminal()];

    const session = fakeSession({
      terminals: [a, b],
      layout: {
        tabs: [
          {
            root: {
              kind: "split",
              axis: "horizontal",
              fraction: 0.5,
              first: { kind: "terminal", id: a.id },
              second: { kind: "terminal", id: b.id },
            },
            focusedTerminalID: a.id,
          },
        ],
        focusedTabIndex: 0,
      },
    });

    const context = harness({ sessions: [session], selection: session.id });

    await createCommandDispatch(context.target)("focusPaneRight");

    expect(context.view.layouts.get(session.id)?.local.tabs[0]?.focusedTerminalID).toBe(b.id);
  });
});

describe("the rest of the terminal menu", () => {
  test("restart is one request: the daemon owns the stop/start ordering", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });
    const context = harness({ sessions: [session], selection: session.id });

    await createCommandDispatch(context.target)("restartTerminal");

    expect(context.sent).toEqual([{ type: "restartTerminal", terminalID: terminal.id }]);
  });

  test("clear scrollback clears this client's viewport and asks the daemon nothing", async () => {
    const terminal = fakeTerminal();
    const session = fakeSession({ terminals: [terminal] });
    const context = harness({ sessions: [session], selection: session.id });
    const handle = fakeSurfaceHandle();
    context.view.registerSurface(terminal.id, handle);

    await createCommandDispatch(context.target)("clearScrollback");

    expect(handle.calls).toEqual(["clearViewport"]);
    expect(context.sent).toEqual([]);
  });

  test("Reveal in Finder and Open in Terminal name the session's directory", async () => {
    const session = fakeSession({ directory: absolutePath("/tmp/here") });
    const context = harness({ sessions: [session], selection: session.id });
    const dispatch = createCommandDispatch(context.target);

    await dispatch("revealInFinder");
    await dispatch("openInTerminal");

    expect(context.native.calls).toEqual(["revealInFinder:/tmp/here", "openInTerminal:/tmp/here"]);
  });
});

describe("no target", () => {
  test("commands that need a session do nothing when there is none", async () => {
    const context = harness({});
    const dispatch = createCommandDispatch(context.target);

    for (const id of ["splitRight", "closePane", "restartTerminal", "revealInFinder"] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await dispatch(id);
    }

    expect(context.sent).toEqual([]);
    expect(context.native.calls).toEqual([]);
  });

  test("host-only commands do nothing without a local shell", async () => {
    const session = fakeSession({ directory: absolutePath("/tmp/here") });
    const context = harness({ sessions: [session], selection: session.id, local: false });
    const dispatch = createCommandDispatch(context.target);

    for (const id of ["addProject", "openFolder", "revealInFinder", "openInTerminal"] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await dispatch(id);
    }

    expect(context.sent).toEqual([]);
    expect(context.view.sheet).toBeUndefined();
    expect(context.native.calls).toEqual([]);
  });
});
