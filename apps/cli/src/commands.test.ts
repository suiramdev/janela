import { describe, expect, test } from "bun:test";

import { absolutePath, identifier, type TerminalState } from "@janela/core";
import { serializeRemovalPlan, type SessionRemovalPreview } from "@janela/protocol";

import {
  DirectoryNotOurs,
  NotYetVisible,
  RemovalNotConfirmed,
  TerminalNotStarted,
  runCommand,
} from "./commands.ts";
import { Ambiguous, NotFound } from "./lookup.ts";
import { fakeDaemon, project, session, terminal } from "./test-fakes.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const IN_PROJECT = "22222222-2222-4222-8222-222222222222";
const STANDALONE = "33333333-3333-4333-8333-333333333333";
const CREATED = "44444444-4444-4444-8444-444444444444";
const SHELL = "aaaaaaaa-0000-4000-8000-000000000001";
const SERVER = "aaaaaaab-0000-4000-8000-000000000002";
const FRESH_SHELL = "bbbbbbbb-0000-4000-8000-000000000001";

const janela = project(PROJECT, "janela");

const feature = session(
  IN_PROJECT,
  "feature",
  [terminal(SHELL), terminal(SERVER, "Server")],
  janela.id,
);

const scratch = session(STANDALONE, "scratch");

const shellID = identifier<"Terminal">(SHELL);

const serverID = identifier<"Terminal">(SERVER);

const running: TerminalState = { kind: "running" };

function plan(overrides: Partial<SessionRemovalPreview> = {}): string {
  return serializeRemovalPlan({
    liveTerminalCount: 2,
    canDeleteDirectory: true,
    deletesDirectory: false,
    includedPaths: [],
    runsTeardownAutomation: false,
    safety: {
      hasUncommittedChanges: true,
      hasUntrackedFiles: false,
      hasUnpushedCommits: true,
      isLocked: false,
      hasRunningSessions: false,
    },
    ...overrides,
  });
}

describe("list", () => {
  test("projects come with their sessions and terminals; standalone sessions follow", async () => {
    const daemon = fakeDaemon({
      projects: [janela],
      sessions: [scratch, feature],
      terminalStates: { [shellID]: running },
    });

    await runCommand({ kind: "list", json: false }, daemon.context);

    expect(daemon.output.text().split("\n")).toEqual([
      `project\t${PROJECT}\tjanela\t/code/janela`,
      `session\t${IN_PROJECT}\tfeature\t/work/feature\t${PROJECT}`,
      `terminal\t${SHELL}\t${IN_PROJECT}\trunning\tShell`,
      `terminal\t${SERVER}\t${IN_PROJECT}\tidle\tServer`,
      `session\t${STANDALONE}\tscratch\t/work/scratch\t-`,
      "",
    ]);

    expect(daemon.sent).toEqual([]);
  });

  test("--json is the mirror as the daemon sent it", async () => {
    const daemon = fakeDaemon({ projects: [janela], sessions: [feature] });

    await runCommand({ kind: "list", json: true }, daemon.context);

    const parsed: unknown = JSON.parse(daemon.output.text());

    expect(parsed).toEqual({ projects: [janela], sessions: [feature], terminalStates: {} });
  });
});

describe("session create", () => {
  test("a new session is found in the mirror and printed with its first terminal", async () => {
    const daemon = fakeDaemon({
      answer: (request, stores) => {
        if (request.type === "createSession") {
          stores.mirror.apply({
            projects: [],
            sessions: [session(CREATED, "notes", [terminal(FRESH_SHELL)])],
            terminalStates: {},
            isFullSnapshot: false,
          });
        }

        return undefined;
      },
    });

    await runCommand(
      {
        kind: "createSession",
        target: { kind: "directory", directory: "/work/notes" },
        name: "notes",
      },
      daemon.context,
    );

    expect(daemon.sent).toEqual([
      {
        type: "createSession",
        intent: { kind: "standalone", directory: absolutePath("/work/notes"), name: "notes" },
      },
    ]);

    expect(daemon.output.text()).toBe(
      `session\t${CREATED}\tnotes\t/work/notes\t-\n` +
        `terminal\t${FRESH_SHELL}\t${CREATED}\tidle\tShell\n`,
    );
  });

  test("a project is named by name or id prefix, and a new branch becomes a worktree intent", async () => {
    const daemon = fakeDaemon({
      projects: [janela],
      answer: (request, stores) => {
        if (request.type === "createSession") {
          stores.mirror.apply({
            projects: [],
            sessions: [session(CREATED, "cli", [terminal(FRESH_SHELL)], janela.id)],
            terminalStates: {},
            isFullSnapshot: false,
          });
        }

        return undefined;
      },
    });

    await runCommand(
      {
        kind: "createSession",
        target: { kind: "newBranch", project: "1111", branch: "feat/cli", startPoint: "dev" },
        name: undefined,
      },
      daemon.context,
    );

    expect(daemon.sent).toEqual([
      {
        type: "createSession",
        intent: {
          kind: "newWorktree",
          projectID: janela.id,
          branch: "feat/cli",
          startPoint: "dev",
        },
      },
    ]);
  });

  test("an unknown project is refused before anything reaches the daemon", async () => {
    const daemon = fakeDaemon({ projects: [janela] });

    await expect(
      runCommand(
        {
          kind: "createSession",
          target: { kind: "project", project: "elsewhere", branch: undefined },
          name: undefined,
        },
        daemon.context,
      ),
    ).rejects.toBeInstanceOf(NotFound);

    expect(daemon.sent).toEqual([]);
  });

  test("an acknowledgement with no new session in the state is said, not guessed", async () => {
    const daemon = fakeDaemon({ sessions: [scratch] });

    await expect(
      runCommand(
        {
          kind: "createSession",
          target: { kind: "directory", directory: "/work/notes" },
          name: undefined,
        },
        daemon.context,
      ),
    ).rejects.toBeInstanceOf(NotYetVisible);
  });
});

describe("session remove", () => {
  test("the removal plan is shown, and nothing is removed without consent", async () => {
    const daemon = fakeDaemon({
      projects: [janela],
      sessions: [feature],
      answer: (request) => (request.type === "removalPlan" ? plan() : undefined),
    });

    await expect(
      runCommand(
        { kind: "removeSession", session: "feature", yes: false, deleteDirectory: true },
        daemon.context,
      ),
    ).rejects.toBeInstanceOf(RemovalNotConfirmed);

    expect(daemon.sent).toEqual([{ type: "removalPlan", sessionID: feature.id }]);

    expect(daemon.output.text()).toBe(
      `Remove feature (${IN_PROJECT})?\n` +
        "  2 running terminals end.\n" +
        "  /work/feature is deleted.\n" +
        "  It still has uncommitted changes and unpushed commits.\n",
    );
  });

  test("a terminal user who answers yes removes it at the cost shown, keeping the directory", async () => {
    const questions: string[] = [];

    const daemon = fakeDaemon({
      sessions: [feature],
      answer: (request) => (request.type === "removalPlan" ? plan() : undefined),
      confirm: (question) => {
        questions.push(question);

        return Promise.resolve(true);
      },
    });

    await runCommand(
      { kind: "removeSession", session: IN_PROJECT, yes: false, deleteDirectory: false },
      daemon.context,
    );

    expect(questions).toHaveLength(1);

    expect(daemon.output.text()).toContain("/work/feature is kept.");

    expect(daemon.sent).toEqual([
      { type: "removalPlan", sessionID: feature.id },
      { type: "removeSession", sessionID: feature.id, deletesDirectory: false },
    ]);
  });

  test("--yes skips the question, and --delete-directory deletes a directory Janela made", async () => {
    const daemon = fakeDaemon({
      sessions: [feature],
      answer: (request) => (request.type === "removalPlan" ? plan() : undefined),
      confirm: () => Promise.reject(new Error("asked anyway")),
    });

    await runCommand(
      { kind: "removeSession", session: "feature", yes: true, deleteDirectory: true },
      daemon.context,
    );

    expect(daemon.sent.at(-1)).toEqual({
      type: "removeSession",
      sessionID: feature.id,
      deletesDirectory: true,
    });
  });

  test("--delete-directory on a directory Janela did not make is refused, and nothing is removed", async () => {
    const daemon = fakeDaemon({
      sessions: [feature],
      answer: (request) =>
        request.type === "removalPlan" ? plan({ canDeleteDirectory: false }) : undefined,
    });

    await expect(
      runCommand(
        { kind: "removeSession", session: "feature", yes: true, deleteDirectory: true },
        daemon.context,
      ),
    ).rejects.toBeInstanceOf(DirectoryNotOurs);

    expect(daemon.sent).toEqual([{ type: "removalPlan", sessionID: feature.id }]);
  });
});

describe("terminals", () => {
  test("create prints the id the daemon answered with", async () => {
    const daemon = fakeDaemon({
      sessions: [scratch],
      answer: (request) => (request.type === "createTerminal" ? FRESH_SHELL : undefined),
    });

    await runCommand(
      { kind: "createTerminal", session: "scratch", title: "Build" },
      daemon.context,
    );

    expect(daemon.sent).toEqual([
      { type: "createTerminal", sessionID: scratch.id, title: "Build" },
    ]);

    expect(daemon.output.text()).toBe(`${FRESH_SHELL}\n`);
  });

  test("start and read address a terminal by a unique id prefix", async () => {
    const daemon = fakeDaemon({
      sessions: [feature],
      terminalStates: { [shellID]: running },
      answer: (request) => (request.type === "snapshotText" ? "$ make\nok" : undefined),
    });

    await runCommand({ kind: "startTerminal", terminal: SERVER }, daemon.context);
    await runCommand(
      { kind: "readTerminal", terminal: SHELL.slice(0, 8), scrollback: true },
      daemon.context,
    );

    expect(daemon.sent).toEqual([
      { type: "startTerminal", terminalID: serverID },
      { type: "snapshotText", terminalID: shellID, includeScrollback: true },
    ]);

    expect(daemon.output.text()).toBe(`started\t${SERVER}\n$ make\nok\n`);
  });

  test("a terminal never started is refused before the daemon is asked for its screen", async () => {
    const daemon = fakeDaemon({ sessions: [feature] });

    await expect(
      runCommand({ kind: "readTerminal", terminal: SERVER, scrollback: false }, daemon.context),
    ).rejects.toBeInstanceOf(TerminalNotStarted);

    expect(daemon.sent).toEqual([]);
  });

  test("a prefix two terminals share is refused rather than resolved to either", async () => {
    const daemon = fakeDaemon({ sessions: [feature] });

    await expect(
      runCommand({ kind: "startTerminal", terminal: "aaaaaa" }, daemon.context),
    ).rejects.toBeInstanceOf(Ambiguous);

    expect(daemon.sent).toEqual([]);
  });
});
