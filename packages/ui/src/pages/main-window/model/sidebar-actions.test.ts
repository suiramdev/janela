import { describe, expect, test } from "bun:test";

import type { ClientRequest, SessionStore } from "@janela/client";
import type { ProjectID, SessionID } from "@janela/core";
import { serializeRemovalPlan, type SessionRemovalPreview } from "@janela/protocol";

import {
  type RecordingConfirmations,
  fakeProject,
  fakeSession,
  inertNativeShell,
  recordingConfirmations,
  recordingService,
} from "../../../shared/lib/test-fakes/index.ts";
import { createViewState } from "../../../shared/model/index.ts";
import {
  type SidebarActionTarget,
  createSidebarActions,
  projectRemovalPrompt,
  sessionRemovalPrompt,
} from "./sidebar-actions.ts";

interface Harness {
  readonly target: SidebarActionTarget;
  readonly sent: ClientRequest[];
  readonly confirmations: RecordingConfirmations;
}

const projectID = (raw: string): ProjectID => raw as ProjectID;

const sessionID = (raw: string): SessionID => raw as SessionID;

const SAFE: SessionRemovalPreview = {
  liveTerminalCount: 0,
  canDeleteDirectory: false,
  deletesDirectory: false,
  includedPaths: [],
  runsTeardownAutomation: false,
  safety: {
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    hasUnpushedCommits: false,
    isLocked: false,
    hasRunningSessions: false,
  },
};

const noop = (): (() => void) => () => {};

function emptySessionStore(): SessionStore {
  return {
    sessions: [],
    selection: undefined,
    terminalStates: {},
    launchProfiles: [],
    launchProfileAvailability: {},
    inProject: () => [],
    standaloneSessions: [],
    isRunning: () => false,
    subscribe: noop,
  };
}

function harness(options: {
  readonly agrees: boolean;
  readonly plan?: SessionRemovalPreview;
  readonly sessions?: SessionStore;
}): Harness {
  const sent: ClientRequest[] = [];
  const confirmations = recordingConfirmations({ agrees: options.agrees, silenced: undefined });
  const sessions = options.sessions ?? emptySessionStore();

  const target: SidebarActionTarget = {
    sessions,
    connection: {
      request: async (message) => {
        sent.push(message as ClientRequest);

        if (message.type === "removalPlan") {
          return serializeRemovalPlan(options.plan ?? SAFE);
        }

        return undefined;
      },
    },
    view: createViewState(sessions),
    local: { native: inertNativeShell(), service: recordingService(), restartDaemon: noop },
    confirmations,
  };

  return {
    target,
    sent,
    confirmations,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createSidebarActions", () => {
  test("a new session opens the branch dialog for the project it was asked for", () => {
    const { target, sent } = harness({ agrees: true });

    createSidebarActions(target).newSession(projectID("p"));

    expect(target.view.sheet).toEqual({ kind: "newSession", projectID: projectID("p") });
    expect(sent).toEqual([]);
  });

  test("a new terminal is a shell in that session, with nothing to pick", async () => {
    const { target, sent } = harness({ agrees: true });

    createSidebarActions(target).newTerminal(sessionID("s"));
    await Promise.resolve();

    expect(target.view.sheet).toBeUndefined();
    expect(sent).toEqual([{ type: "createTerminal", sessionID: sessionID("s") }]);
  });

  test("project settings navigate to that project's pane in settings, not to a sheet", () => {
    const { target } = harness({ agrees: true });

    createSidebarActions(target).openProjectSettings(projectID("p"));

    expect(target.view.screen).toEqual({
      kind: "settings",
      route: { kind: "project", projectID: projectID("p") },
    });
    expect(target.view.sheet).toBeUndefined();
  });

  test("removing a session asks the daemon what it costs before asking the user", async () => {
    const { target, sent, confirmations } = harness({
      agrees: true,
      plan: { ...SAFE, liveTerminalCount: 2, canDeleteDirectory: true, deletesDirectory: true },
    });

    const session = fakeSession({ id: sessionID("s"), name: "fix/pty" });

    createSidebarActions(target).removeSession(session);
    await tick();

    expect(sent.map((message) => message.type)).toEqual(["removalPlan", "removeSession"]);
    expect(confirmations.titles).toEqual(["Remove fix/pty?"]);
    expect(sent[1]).toEqual({
      type: "removeSession",
      sessionID: sessionID("s"),
      deletesDirectory: true,
    });
  });

  test("declining a removal sends nothing", async () => {
    const { target, sent } = harness({ agrees: false });

    createSidebarActions(target).removeSession(fakeSession({ id: sessionID("s") }));
    await tick();

    expect(sent.map((message) => message.type)).toEqual(["removalPlan"]);
  });

  test("declining a project removal sends nothing", async () => {
    const { target, sent, confirmations } = harness({ agrees: false });

    createSidebarActions(target).removeProject(fakeProject({ id: projectID("p") }));
    await tick();

    expect(confirmations.titles).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test("agreeing removes the project", async () => {
    const { target, sent } = harness({ agrees: true });

    createSidebarActions(target).removeProject(fakeProject({ id: projectID("p") }));
    await tick();

    expect(sent).toEqual([{ type: "removeProject", projectID: projectID("p") }]);
  });
});

describe("sessionRemovalPrompt", () => {
  const session = fakeSession({ name: "fix/pty" });

  test("a directory that is kept is said to be kept", () => {
    const prompt = sessionRemovalPrompt(session, { ...SAFE, canDeleteDirectory: true });

    expect(prompt.message).toContain("is kept");
    expect(prompt.message).not.toContain("deleted");
  });

  test("nothing to warn about still says what happens", () => {
    expect(sessionRemovalPrompt(session, SAFE).message.length).toBeGreaterThan(0);
  });

  test("cannot be silenced: it is the question that can delete a directory", () => {
    expect(sessionRemovalPrompt(session, SAFE).remember).toBeUndefined();
    expect(projectRemovalPrompt(fakeProject({ name: "janela" }), 2).remember).toBeUndefined();
  });

  test("live terminals are counted, and the count reads as English", () => {
    expect(sessionRemovalPrompt(session, { ...SAFE, liveTerminalCount: 1 }).message).toContain(
      "1 running terminal ends",
    );
    expect(sessionRemovalPrompt(session, { ...SAFE, liveTerminalCount: 3 }).message).toContain(
      "3 running terminals end",
    );
  });

  test("work that would be lost is named, not summarised as unsafe", () => {
    const prompt = sessionRemovalPrompt(session, {
      ...SAFE,
      canDeleteDirectory: true,
      deletesDirectory: true,
      safety: {
        hasUncommittedChanges: true,
        hasUntrackedFiles: false,
        hasUnpushedCommits: true,
        isLocked: false,
        hasRunningSessions: false,
      },
    });

    expect(prompt.message).toContain("uncommitted changes and unpushed commits");
    expect(prompt.message).not.toContain("unsafe");
  });

  test("copied-in files are counted, because they are not in git", () => {
    const prompt = sessionRemovalPrompt(session, {
      ...SAFE,
      canDeleteDirectory: true,
      deletesDirectory: true,
      includedPaths: [".env", ".env.local"],
    });

    expect(prompt.message).toContain("2 copied-in file(s)");
  });

  test("a teardown command is announced: it runs before anything is deleted", () => {
    const prompt = sessionRemovalPrompt(session, { ...SAFE, runsTeardownAutomation: true });

    expect(prompt.message).toContain("teardown command runs first");
  });
});

describe("projectRemovalPrompt", () => {
  const project = fakeProject({ name: "janela" });

  test("an empty project promises nothing on disk changes", () => {
    const prompt = projectRemovalPrompt(project, 0);

    expect(prompt.message).toContain("Nothing on disk changes");
  });

  test("the sessions that go with it are counted, and agree in number", () => {
    expect(projectRemovalPrompt(project, 1).message).toContain("Its session goes with it");
    expect(projectRemovalPrompt(project, 4).message).toContain("Its 4 sessions go with it");
  });
});
