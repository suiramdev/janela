import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";

import type {
  AutomationScripts,
  Project,
  ProjectID,
  Session,
  TerminalDescriptor,
} from "@janela/core";
import { absolutePath, emptyLayout, newProjectID, newSessionID, now } from "@janela/core";
import type { TerminalRegistry } from "@janela/terminal";
import { createTerminalRegistry } from "@janela/terminal";
import { temporaryDirectory } from "@janela/test-support";
import { Duration, Effect } from "effect";

import { automationRunner, automationTitle, type AutomationRunning } from "./automation-runner.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import {
  eventLog,
  fakeCreateTerminal,
  recordingLogger,
  scriptedProcesses,
  type EventLog,
  type FakeTerminalFactory,
  type RecordedLog,
} from "./test-fakes.ts";

interface Fixture {
  readonly runner: AutomationRunning;
  readonly terminals: TerminalRegistry;
  readonly factory: FakeTerminalFactory;
  readonly events: EventLog;
  readonly records: readonly RecordedLog[];
  readonly attached: readonly TerminalDescriptor[];
  readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
}

interface FixtureOptions {
  readonly attachFails?: boolean;
}

const projectID: ProjectID = newProjectID();

const APPEARANCE_TIMEOUT_MS = 1000;

const APPEARANCE_POLL_MS = 1;

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-fish"],
};

const sessionRecord = (overrides: Partial<Session> = {}): Session => ({
  id: newSessionID(),
  projectID,
  name: "feature",
  directory: absolutePath("/Users/x/code/.worktrees/feature"),
  backing: { kind: "projectDirectory" },
  terminals: [],
  layout: emptyLayout,
  accent: "none",
  createdAt: now(),
  lastActiveAt: now(),
  isPinned: false,
  ...overrides,
});

const projectWith = (automation: AutomationScripts): Project => ({
  id: projectID,
  name: "janela",
  directory: absolutePath("/Users/x/code/janela"),
  git: { defaultBranch: "main" },
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation },
  accent: "none",
  isExpanded: true,
  addedAt: now(),
});

function fixture(options: FixtureOptions = {}): Fixture {
  const events = eventLog();
  const factory = fakeCreateTerminal(events);
  const terminals = createTerminalRegistry();
  const { logger, records } = recordingLogger();
  const attached: TerminalDescriptor[] = [];

  return {
    runner: automationRunner({
      terminals,
      shell,
      processes: scriptedProcesses({ which: {} }).processes,
      createTerminal: factory.create,
      log: logger,
      pollIntervalMs: APPEARANCE_POLL_MS,
    }),
    terminals,
    factory,
    events,
    records,
    attached,
    attach: async (descriptor: TerminalDescriptor): Promise<void> => {
      events.record("attach");

      if (options.attachFails === true) throw new Error("client gone");

      attached.push(descriptor);
    },
  };
}

async function terminalsToAppear(factory: FakeTerminalFactory, count: number): Promise<void> {
  await Effect.runPromise(
    Effect.timeoutOption(
      Effect.gen(function* () {
        while (factory.created.length < count) {
          yield* Effect.sleep(Duration.millis(APPEARANCE_POLL_MS));
        }
      }),
      Duration.millis(APPEARANCE_TIMEOUT_MS),
    ),
  );
}

async function exitFirstTerminal(factory: FakeTerminalFactory, code: number): Promise<void> {
  await terminalsToAppear(factory, 1);
  factory.created[0]?.setState({ kind: "exited", code });
}

describe("automationRunner", () => {
  test("one automation-role terminal for the event's script, titled by its first command", async () => {
    const fake = fixture();
    const session = sessionRecord();
    const project = projectWith({
      worktreeCreated: {
        script: "# bring the stack up\ndocker compose up -d\npnpm install",
        timeoutSeconds: 30,
      },
    });

    const report = await fake.runner.run({
      event: "worktreeCreated",
      project,
      session,
      attach: fake.attach,
    });

    expect(fake.attached.map((descriptor) => descriptor.title)).toEqual(["docker compose up -d"]);
    expect(fake.attached[0]?.role).toEqual({ kind: "automation", event: "worktreeCreated" });
    expect(fake.attached[0]?.startsAutomatically).toBe(false);
    expect(fake.terminals.inSession(session.id).map((terminal) => terminal.id)).toEqual(
      fake.attached.map((descriptor) => descriptor.id),
    );
    expect(fake.factory.created.map((handle) => handle.starts())).toEqual([1]);
    expect(fake.events.entries).toEqual(["attach", "terminal.create"]);
    expect(report.outcome?.terminal).toBe(fake.attached[0]?.id);
  });

  test("the script is handed verbatim to the login shell, in the session's directory, with the namespace", async () => {
    const fake = fixture();
    const session = sessionRecord();
    const script =
      'cp "$JANELA_PROJECT_DIRECTORY/.env" "$JANELA_SESSION_DIRECTORY/.env"\npnpm install';

    await fake.runner.run({
      event: "worktreeCreated",
      project: projectWith({ worktreeCreated: { script, timeoutSeconds: 30 } }),
      session,
      attach: fake.attach,
    });

    const launch = fake.factory.created[0]?.launch;

    expect(launch?.executable).toBe(shell.loginShell);
    expect(launch?.arguments).toEqual([shell.loginShell, "-c", script]);
    expect(launch?.workingDirectory).toBe(session.directory);
    expect(launch?.environment["JANELA_AUTOMATION_EVENT"]).toBe("worktreeCreated");
    expect(launch?.environment["JANELA_PROJECT_DIRECTORY"]).toBe("/Users/x/code/janela");
    expect(launch?.environment["JANELA_SESSION_DIRECTORY"]).toBe(session.directory);
    expect(launch?.environment["JANELA_PROJECT"]).toBe("janela");
  });

  test("an absent, blank or comment-only script runs nothing and creates no terminal", async () => {
    for (const automation of [
      {},
      { sessionStart: { script: "", timeoutSeconds: 30 } },
      { sessionStart: { script: "  \n\n", timeoutSeconds: 30 } },
      { sessionStart: { script: "# nothing yet\n  # still nothing", timeoutSeconds: 30 } },
    ] satisfies readonly AutomationScripts[]) {
      const fake = fixture();

      // oxlint-disable-next-line no-await-in-loop
      const report = await fake.runner.run({
        event: "sessionStart",
        project: projectWith(automation),
        session: sessionRecord(),
        attach: fake.attach,
      });

      expect(report).toEqual({ event: "sessionStart" });
      expect(fake.factory.created).toHaveLength(0);
      expect(fake.events.entries).toEqual([]);
    }
  });

  test("a non-teardown event returns after creation, not after completion", async () => {
    const fake = fixture();

    const report = await fake.runner.run({
      event: "sessionStart",
      project: projectWith({ sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } }),
      session: sessionRecord(),
      attach: fake.attach,
    });

    expect(fake.factory.created[0]?.terminal.state).toEqual({ kind: "running" });
    expect(report.outcome?.terminal).toBe(fake.attached[0]?.id);
    expect(report.outcome?.timedOut).toBe(false);
    expect(report.outcome?.exitCode).toBeUndefined();
    expect(report.outcome?.failure).toBeUndefined();
  });

  test("scripts come only from the database, never from a file in the repository", async () => {
    await using directory = await temporaryDirectory("automation-runner");

    await writeFile(
      directory.join("janela.toml"),
      '[[automation]]\nevent = "sessionStart"\ncommand = ["make", "hostile"]\n',
      "utf8",
    );
    await mkdir(directory.join(".janela"), { recursive: true });
    await writeFile(directory.join(".janela/sessionStart.sh"), "make hostile\n", "utf8");
    await writeFile(directory.join("Makefile"), "hostile:\n\t@echo no\n", "utf8");

    const fake = fixture();
    await fake.runner.run({
      event: "sessionStart",
      project: projectWith({ sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } }),
      session: sessionRecord({ directory: absolutePath(directory.path) }),
      attach: fake.attach,
    });

    expect(fake.factory.created).toHaveLength(1);
    expect(fake.factory.created[0]?.launch.arguments).toEqual([shell.loginShell, "-c", "pnpm dev"]);
  });

  test("sessionStart fires once per session, across a daemon restart", async () => {
    const fake = fixture();
    const project = projectWith({ sessionStart: { script: "pnpm dev", timeoutSeconds: 30 } });
    const session = sessionRecord();

    await fake.runner.run({ event: "sessionStart", project, session, attach: fake.attach });

    expect(fake.factory.created).toHaveLength(1);

    const restored = sessionRecord({ id: session.id, terminals: [...fake.attached] });
    const second = await fake.runner.run({
      event: "sessionStart",
      project,
      session: restored,
      attach: fake.attach,
    });

    expect(second.outcome).toBeUndefined();
    expect(fake.factory.created).toHaveLength(1);
    expect(fake.attached).toHaveLength(1);
  });

  test("a teardown blocks, bounded by its own timeout, and does not kill the script", async () => {
    const fake = fixture();

    const report = await fake.runner.run({
      event: "sessionTeardown",
      project: projectWith({
        sessionTeardown: { script: "docker compose down", timeoutSeconds: 0.05 },
      }),
      session: sessionRecord(),
      attach: fake.attach,
    });

    expect(report.outcome?.timedOut).toBe(true);
    expect(report.outcome?.exitCode).toBeUndefined();
    expect(fake.factory.created[0]?.stops()).toBe(0);
    expect(fake.records.map((record) => record.message)).toContain("automation teardown timed out");
  });

  test("a teardown that exits reports its code, success or not", async () => {
    for (const code of [0, 1]) {
      const fake = fixture();
      const session = sessionRecord();

      // oxlint-disable-next-line no-await-in-loop
      const [report] = await Promise.all([
        fake.runner.run({
          event: "sessionTeardown",
          project: projectWith({
            sessionTeardown: { script: "docker compose down\nmake clean", timeoutSeconds: 5 },
          }),
          session,
          attach: fake.attach,
        }),
        exitFirstTerminal(fake.factory, code),
      ]);

      expect(report.outcome?.exitCode).toBe(code);
      expect(report.outcome?.timedOut).toBe(false);
      expect(fake.terminals.inSession(session.id)).toHaveLength(1);
    }
  });

  test("a teardown runs to completion when the client that asked has gone", async () => {
    const fake = fixture({ attachFails: true });

    const [report] = await Promise.all([
      fake.runner.run({
        event: "sessionTeardown",
        project: projectWith({
          sessionTeardown: { script: "docker compose down", timeoutSeconds: 5 },
        }),
        session: sessionRecord(),
        attach: fake.attach,
      }),
      exitFirstTerminal(fake.factory, 0),
    ]);

    expect(report.outcome?.exitCode).toBe(0);

    const failures = fake.records.filter((record) => record.message === "automation attach failed");

    expect(failures).toHaveLength(1);
    expect(Object.keys(failures[0]?.fields ?? {}).toSorted()).toEqual(["event", "session"]);
  });
});

describe("automationTitle", () => {
  test("is the first line that is not blank or a comment", () => {
    expect(automationTitle("sessionStart", "\n# setup\n\n  pnpm install\nmake")).toBe(
      "pnpm install",
    );
  });

  test("falls back to the event when every line is blank or a comment", () => {
    expect(automationTitle("sessionTeardown", "# soon\n\n")).toBe("sessionTeardown");
  });
});
