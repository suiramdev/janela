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

import { createCommandDispatch, sessionOrder, type CommandTarget } from "./command-dispatch.ts";
import { COMMANDS } from "./commands.ts";
import {
  fakeProfile,
  fakeProject,
  fakeSession,
  fakeSurfaceHandle,
  fakeTerminal,
  inertNativeShell,
  type RecordingNativeShell,
} from "./test-fakes.ts";
import { createViewState, type ViewState } from "./view-state.ts";

interface Harness {
  readonly target: CommandTarget;
  readonly view: ViewState;
  readonly sessions: SessionStore;
  readonly sent: ClientRequest[];
  readonly native: RecordingNativeShell;
  /** Appears in the mirror when the next `createSession` is answered. */
  appears: Session | undefined;
}

function harness(options: {
  readonly projects?: readonly Project[];
  readonly sessions?: readonly Session[];
  readonly selection?: SessionID;
  readonly states?: Readonly<Record<TerminalID, TerminalState>>;
  readonly profiles?: readonly ReturnType<typeof fakeProfile>[];
  readonly confirms?: boolean;
  readonly picks?: string;
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

  const appearing: { session: Session | undefined } = { session: undefined };
  const native = inertNativeShell();
  const recording: RecordingNativeShell = {
    calls: native.calls,
    pickDirectory: async (request) => {
      await native.pickDirectory(request);
      return options.picks === undefined ? undefined : absolutePath(options.picks);
    },
    confirm: async (request) => {
      await native.confirm(request);
      return options.confirms === true;
    },
    revealInFinder: native.revealInFinder,
    openInTerminal: native.openInTerminal,
  };

  const view = createViewState(sessionStore);
  const target: CommandTarget = {
    projects: projectStore,
    sessions: sessionStore,
    view,
    native: recording,
    connection: {
      request: (message) => {
        sent.push(message);
        if (message.type === "createSession" && appearing.session !== undefined) {
          // The daemon publishes the snapshot before the reply, on the same ordered
          // queue, so the mirror already has the new session when this settles.
          sessions = [...sessions, appearing.session];
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
    get appears(): Session | undefined {
      return appearing.session;
    },
    set appears(next: Session | undefined) {
      appearing.session = next;
    },
  };
}

const AT = instant("2026-01-01T00:00:00.000Z");

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

describe("sheets", () => {
  test("the four sheet commands open their own sheet", async () => {
    const session = fakeSession();
    const { target, view } = harness({ sessions: [session], selection: session.id });
    const dispatch = createCommandDispatch(target);

    await dispatch("goToSession");
    expect(view.sheet).toEqual({ kind: "jumpList" });
    await dispatch("showCommands");
    expect(view.sheet).toEqual({ kind: "commands" });
    await dispatch("newBranchSession");
    expect(view.sheet).toEqual({ kind: "newBranch" });
    await dispatch("openSettings");
    expect(view.sheet).toEqual({ kind: "settings" });
    await dispatch("newTerminal");
    expect(view.sheet).toEqual({ kind: "profilePicker", sessionID: session.id });
  });
});

describe("creation", () => {
  test("New Session in a project makes another session in that project", async () => {
    const project = fakeProject();
    const session = fakeSession({ projectID: project.id });
    const appeared = fakeSession({
      projectID: project.id,
      terminals: [fakeTerminal()],
      createdAt: AT,
    });
    const context = harness({
      projects: [project],
      sessions: [session],
      selection: session.id,
    });
    context.appears = appeared;
    const handle = fakeSurfaceHandle();
    const firstTerminal = appeared.terminals[0];
    if (firstTerminal === undefined) throw new Error("the fixture has no terminal");
    context.view.registerSurface(firstTerminal.id, handle);

    await createCommandDispatch(context.target)("newSession");

    expect(context.sent).toEqual([
      { type: "createSession", intent: { kind: "inProject", projectID: project.id } },
    ]);
    // Selected *and* focused: creating a session means wanting to type in it, and
    // a row highlighted in the sidebar is not a keyboard in the pane.
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
  test("a split names the focused pane and inherits its profile", async () => {
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
        profileID: profile.id,
      },
      {
        type: "createTerminal",
        sessionID: session.id,
        placement: { kind: "split", beside: terminal.id, axis: "vertical" },
        profileID: profile.id,
      },
    ]);
  });

  test("a profile the mirror no longer has is left off rather than sent stale", async () => {
    const terminal = fakeTerminal({ profileID: fakeProfile().id });
    const session = fakeSession({ terminals: [terminal] });
    const context = harness({ sessions: [session], selection: session.id });

    await createCommandDispatch(context.target)("splitRight");

    expect(context.sent[0]).toEqual({
      type: "createTerminal",
      sessionID: session.id,
      placement: { kind: "split", beside: terminal.id, axis: "horizontal" },
    });
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

    expect(context.native.calls).toEqual(["confirm:Close this pane?"]);
    expect(context.sent).toEqual([]);
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

    expect(context.native.calls).toEqual([]);
    expect(context.sent).toEqual([{ type: "removeTerminal", terminalID: terminal.id }]);
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
});
