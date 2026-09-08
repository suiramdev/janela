import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";

import type {
  AutomationCommand,
  Project,
  ProjectID,
  Session,
  TerminalDescriptor,
} from "@janela/core";
import {
  absolutePath,
  emptyLayout,
  newAutomationID,
  newProjectID,
  newSessionID,
  now,
} from "@janela/core";
import type { TerminalRegistry } from "@janela/terminal";
import { createTerminalRegistry } from "@janela/terminal";
import { temporaryDirectory } from "@janela/test-support";

import { automationRunner, type AutomationRunning } from "./automation-runner.ts";
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

const projectID: ProjectID = newProjectID();

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" },
  loginShellArguments: () => ["-fish"],
};

/** Everything the fixture's `which` can find. Anything else is not installed. */
const installed = {
  docker: "/usr/local/bin/docker",
  pnpm: "/opt/homebrew/bin/pnpm",
  make: "/usr/bin/make",
};

const sessionRecord = (overrides?: Partial<Session>): Session => ({
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

const commandRecord = (overrides?: Partial<AutomationCommand>): AutomationCommand => ({
  id: newAutomationID(),
  event: "worktreeCreated",
  command: ["docker", "compose", "up", "-d"],
  isEnabled: true,
  timeoutSeconds: 30,
  ...overrides,
});

const projectWith = (automation: readonly AutomationCommand[]): Project => ({
  id: projectID,
  name: "janela",
  directory: absolutePath("/Users/x/code/janela"),
  git: { defaultBranch: "main" },
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation, isForgeEnabled: true },
  accent: "none",
  isExpanded: true,
  addedAt: now(),
});

interface Fixture {
  readonly runner: AutomationRunning;
  readonly terminals: TerminalRegistry;
  readonly factory: FakeTerminalFactory;
  readonly events: EventLog;
  readonly records: readonly RecordedLog[];
  /** Descriptors the sink accepted, in order. */
  readonly attached: readonly TerminalDescriptor[];
  readonly attach: (descriptor: TerminalDescriptor) => Promise<void>;
}

/**
 * A runner over a real registry with the terminal-creation seam faked.
 *
 * What is faked and why: the decision under test is *what runs, in what order,
 * and what the user can see* — not a subprocess. `@janela/terminal` owns whether
 * a PTY works, and a real one here would only add a child process to a test
 * about sequencing.
 */
function fixture(options?: {
  readonly which?: Readonly<Record<string, string>>;
  /** Every attach rejects: the client that asked has gone away. */
  readonly attachFails?: boolean;
}): Fixture {
  const events = eventLog();
  const factory = fakeCreateTerminal(events);
  const terminals = createTerminalRegistry();
  const { logger, records } = recordingLogger();
  const attached: TerminalDescriptor[] = [];

  return {
    runner: automationRunner({
      terminals,
      shell,
      processes: scriptedProcesses({ which: options?.which ?? installed }).processes,
      createTerminal: factory.create,
      log: logger,
      // The production interval would make every teardown test a sleep.
      pollIntervalMs: 1,
    }),
    terminals,
    factory,
    events,
    records,
    attached,
    attach: async (descriptor: TerminalDescriptor): Promise<void> => {
      events.record("attach");
      if (options?.attachFails === true) throw new Error("client gone");
      attached.push(descriptor);
    },
  };
}

/** Waits, briefly and boundedly, for the runner to have created `count` terminals. */
async function terminalsToAppear(factory: FakeTerminalFactory, count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (factory.created.length < count && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

/**
 * Exits each teardown terminal as it appears, in order.
 *
 * The daemon's frame loop is what advances `state` in production; a fake terminal
 * has to be told. Driving it one at a time is also the only honest way to run a
 * teardown test: the nth terminal does not exist until the (n-1)th has exited.
 */
async function exitEachTerminal(
  factory: FakeTerminalFactory,
  codes: readonly number[],
): Promise<void> {
  for (const [index, code] of codes.entries()) {
    // oxlint-disable-next-line no-await-in-loop
    await terminalsToAppear(factory, index + 1);
    factory.created[index]?.setState({ kind: "exited", code });
  }
}

describe("automationRunner", () => {
  test("one automation-role terminal per enabled command, in order", async () => {
    const fake = fixture();
    const session = sessionRecord();
    const project = projectWith([
      commandRecord({ command: ["docker", "compose", "up", "-d"] }),
      commandRecord({ command: ["make", "setup"], isEnabled: false }),
      commandRecord({ command: ["pnpm", "install"] }),
    ]);

    const report = await fake.runner.run({
      event: "worktreeCreated",
      project,
      session,
      attach: fake.attach,
    });

    // The disabled one is not "skipped and reported"; it did not happen.
    expect(fake.attached.map((descriptor) => descriptor.title)).toEqual([
      "docker compose up -d",
      "pnpm install",
    ]);
    expect(fake.attached[0]?.role).toEqual({ kind: "automation", event: "worktreeCreated" });
    // The runner starts them itself; a restored session must not respawn them.
    expect(fake.attached.map((descriptor) => descriptor.startsAutomatically)).toEqual([
      false,
      false,
    ]);
    expect(fake.terminals.inSession(session.id).map((terminal) => terminal.id)).toEqual(
      fake.attached.map((descriptor) => descriptor.id),
    );
    expect(fake.factory.created.map((handle) => handle.starts())).toEqual([1, 1]);
    // Attached before created, per command: a terminal the user cannot see until
    // its process has finished is not a visible terminal.
    expect(fake.events.entries).toEqual(["attach", "terminal.create", "attach", "terminal.create"]);
    expect(report.commands.map((entry) => entry.command.command[0])).toEqual(["docker", "pnpm"]);
  });

  test("argv is executed directly, never through a shell", async () => {
    const fake = fixture();
    const session = sessionRecord();

    await fake.runner.run({
      event: "worktreeCreated",
      project: projectWith([commandRecord({ command: ["pnpm", "install", "--frozen-lockfile"] })]),
      session,
      attach: fake.attach,
    });

    const launch = fake.factory.created[0]?.launch;
    expect(launch?.executable).toBe("/opt/homebrew/bin/pnpm");
    // Verbatim, with no `sh -c` and therefore no quoting bug class.
    expect(launch?.arguments).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(launch?.workingDirectory).toBe(session.directory);
    // So one script can branch on why it was invoked.
    expect(launch?.environment["JANELA_AUTOMATION_EVENT"]).toBe("worktreeCreated");
  });

  test("a non-teardown event returns after creation, not after completion", async () => {
    const fake = fixture();
    const command = commandRecord({ event: "sessionStart", command: ["pnpm", "dev"] });

    const report = await fake.runner.run({
      event: "sessionStart",
      project: projectWith([command]),
      session: sessionRecord(),
      attach: fake.attach,
    });

    // Still running, and nothing waited for it: `pnpm dev` never exits.
    expect(fake.factory.created[0]?.terminal.state).toEqual({ kind: "running" });
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]?.command).toBe(command);
    expect(report.commands[0]?.terminal).toBe(fake.attached[0]?.id);
    expect(report.commands[0]?.timedOut).toBe(false);
    // Absent, not zero: nothing has exited, and inventing a status would say it had.
    expect(report.commands[0]?.exitCode).toBeUndefined();
    expect(report.commands[0]?.failure).toBeUndefined();
  });

  test("commands come only from the database, never from a file in the repository", async () => {
    await using directory = await temporaryDirectory("automation-runner");
    // A checkout that can add commands makes cloning a repository a
    // code-execution vector, so these are furniture and nothing reads them.
    await writeFile(
      directory.join("janela.toml"),
      '[[automation]]\nevent = "sessionStart"\ncommand = ["make", "hostile"]\n',
      "utf8",
    );
    await mkdir(directory.join(".janela"), { recursive: true });
    await writeFile(
      directory.join(".janela/commands.json"),
      JSON.stringify([{ event: "sessionStart", command: ["make", "hostile"] }]),
      "utf8",
    );
    await writeFile(directory.join("Makefile"), "hostile:\n\t@echo no\n", "utf8");

    const fake = fixture();
    await fake.runner.run({
      event: "sessionStart",
      project: projectWith([commandRecord({ event: "sessionStart", command: ["pnpm", "dev"] })]),
      session: sessionRecord({ directory: absolutePath(directory.path) }),
      attach: fake.attach,
    });

    expect(fake.factory.created).toHaveLength(1);
    expect(fake.factory.created[0]?.launch.arguments).toEqual(["pnpm", "dev"]);
  });

  test("sessionStart fires once per session, across a daemon restart", async () => {
    const fake = fixture();
    const project = projectWith([
      commandRecord({ event: "sessionStart", command: ["pnpm", "dev"] }),
    ]);
    const session = sessionRecord();

    await fake.runner.run({ event: "sessionStart", project, session, attach: fake.attach });
    expect(fake.factory.created).toHaveLength(1);

    // The persisted descriptor is the record, which is what a restarted daemon
    // loads. Restarting Janela does not re-run `pnpm dev`.
    const restored = sessionRecord({ id: session.id, terminals: [...fake.attached] });
    const second = await fake.runner.run({
      event: "sessionStart",
      project,
      session: restored,
      attach: fake.attach,
    });

    expect(second.commands).toEqual([]);
    expect(fake.factory.created).toHaveLength(1);
    expect(fake.attached).toHaveLength(1);
  });

  test("a teardown blocks, bounded by its own timeout, and does not kill the command", async () => {
    const fake = fixture();

    const report = await fake.runner.run({
      event: "sessionTeardown",
      project: projectWith([
        commandRecord({
          event: "sessionTeardown",
          command: ["docker", "compose", "down"],
          timeoutSeconds: 0.05,
        }),
      ]),
      session: sessionRecord(),
      attach: fake.attach,
    });

    expect(report.commands[0]?.timedOut).toBe(true);
    expect(report.commands[0]?.exitCode).toBeUndefined();
    // `removeSession`'s stop-all loop is next and terminates it; killing it here
    // would only make the report lie about which of us did.
    expect(fake.factory.created[0]?.stops()).toBe(0);
    expect(fake.records.map((record) => record.message)).toContain("automation teardown timed out");
  });

  test("a failing teardown command is visible and does not stop the next one", async () => {
    const fake = fixture();
    const session = sessionRecord();

    const [report] = await Promise.all([
      fake.runner.run({
        event: "sessionTeardown",
        project: projectWith([
          commandRecord({
            event: "sessionTeardown",
            command: ["docker", "compose", "down"],
            timeoutSeconds: 5,
          }),
          commandRecord({
            event: "sessionTeardown",
            command: ["make", "clean"],
            timeoutSeconds: 5,
          }),
        ]),
        session,
        attach: fake.attach,
      }),
      exitEachTerminal(fake.factory, [1, 0]),
    ]);

    expect(report.commands.map((entry) => entry.exitCode)).toEqual([1, 0]);
    expect(report.commands.map((entry) => entry.timedOut)).toEqual([false, false]);
    // Left registered, showing the exit: a non-zero status is something the user
    // reads, not something we hide.
    expect(fake.terminals.inSession(session.id)).toHaveLength(2);
  });

  test("teardown commands run in order, never in parallel", async () => {
    const fake = fixture();

    const running = fake.runner.run({
      event: "sessionTeardown",
      project: projectWith([
        commandRecord({
          event: "sessionTeardown",
          command: ["docker", "compose", "down"],
          timeoutSeconds: 5,
        }),
        commandRecord({ event: "sessionTeardown", command: ["make", "clean"], timeoutSeconds: 5 }),
      ]),
      session: sessionRecord(),
      attach: fake.attach,
    });

    await terminalsToAppear(fake.factory, 1);
    // Twenty polls' worth of waiting, and the second command still has not
    // started: the first one is what teardown is waiting for.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(fake.factory.created).toHaveLength(1);

    fake.factory.created[0]?.setState({ kind: "exited", code: 0 });
    await terminalsToAppear(fake.factory, 2);
    expect(fake.factory.created).toHaveLength(2);
    fake.factory.created[1]?.setState({ kind: "exited", code: 0 });

    expect((await running).commands.map((entry) => entry.exitCode)).toEqual([0, 0]);
  });

  test("a teardown runs to completion when the client that asked has gone", async () => {
    const fake = fixture({ attachFails: true });

    const [report] = await Promise.all([
      fake.runner.run({
        event: "sessionTeardown",
        project: projectWith([
          commandRecord({
            event: "sessionTeardown",
            command: ["docker", "compose", "down"],
            timeoutSeconds: 5,
          }),
          commandRecord({
            event: "sessionTeardown",
            command: ["make", "clean"],
            timeoutSeconds: 5,
          }),
        ]),
        session: sessionRecord(),
        attach: fake.attach,
      }),
      exitEachTerminal(fake.factory, [0, 0]),
    ]);

    // A teardown abandoned because a window closed leaves exactly the containers
    // it exists to clean up.
    expect(report.commands.map((entry) => entry.exitCode)).toEqual([0, 0]);
    const failures = fake.records.filter((record) => record.message === "automation attach failed");
    expect(failures).toHaveLength(2);
    // Shapes, never content: no argv, no output, no environment.
    expect(Object.keys(failures[0]?.fields ?? {}).toSorted()).toEqual([
      "command",
      "event",
      "session",
    ]);
  });

  test("a command whose executable is missing costs only that command", async () => {
    const fake = fixture({ which: { pnpm: installed.pnpm } });
    const missing = commandRecord({ command: ["docker", "compose", "up", "-d"] });
    const present = commandRecord({ command: ["pnpm", "install"] });

    const report = await fake.runner.run({
      event: "worktreeCreated",
      project: projectWith([missing, present]),
      session: sessionRecord(),
      attach: fake.attach,
    });

    expect(report.commands[0]?.command).toBe(missing);
    expect(report.commands[0]?.failure).toBe("launch");
    expect(report.commands[0]?.terminal).toBeUndefined();
    // Nothing was published for it either: there is no terminal to look at.
    expect(fake.attached).toHaveLength(1);
    expect(report.commands[1]?.command).toBe(present);
    expect(report.commands[1]?.terminal).toBe(fake.attached[0]?.id);
    expect(report.commands[1]?.timedOut).toBe(false);
    expect(report.commands[1]?.failure).toBeUndefined();
    expect(fake.factory.created[0]?.launch.executable).toBe("/opt/homebrew/bin/pnpm");
    expect(fake.records.map((record) => record.message)).toContain("automation launch failed");
  });
});
