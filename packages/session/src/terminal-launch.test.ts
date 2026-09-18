import { describe, expect, test } from "bun:test";

import type {
  AbsolutePath,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import { emptyLayout, now } from "@janela/core";

import { ExecutableUnavailable } from "./errors.ts";
import type { ShellEnvironment } from "./shell-environment.ts";
import { DEFAULT_INITIAL_SIZE, resolveTerminalLaunch } from "./terminal-launch.ts";
import { scriptedProcesses } from "./test-fakes.ts";

const projectID = "1c8c9c8e-0e1a-4f2c-9a10-6c1c1f0b9f11" as ProjectID;

const shell: ShellEnvironment = {
  loginShell: "/opt/homebrew/bin/fish",
  resolved: { PATH: "/opt/homebrew/bin:/usr/bin", TERM: "dumb", EDITOR: "hx" },
  loginShellArguments: () => ["-fish"],
};

const session: Session = {
  id: "0f6e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b" as SessionID,
  projectID,
  name: "feature",
  directory: "/Users/x/code/.worktrees/feature" as AbsolutePath,
  backing: { kind: "projectDirectory" },
  terminals: [],
  layout: emptyLayout,
  accent: "none",
  createdAt: now(),
  lastActiveAt: now(),
  isPinned: false,
};

const project: Project = {
  id: projectID,
  name: "janela",
  directory: "/Users/x/code/janela" as AbsolutePath,
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: {} },
  accent: "none",
  isExpanded: true,
  addedAt: now(),
};

const descriptor = (overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor => ({
  id: "b2c3d4e5-f607-4182-93a4-b5c6d7e8f901" as TerminalID,
  title: "Shell",
  startsAutomatically: true,
  role: { kind: "user" },
  createdAt: now(),
  ...overrides,
});

const rejection = (work: Promise<unknown>): Promise<Error> =>
  work.then(
    () => {
      throw new Error("the call resolved instead of rejecting");
    },
    (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
  );

describe("resolveTerminalLaunch", () => {
  test("no command means the login shell, with a dash-prefixed argv[0]", async () => {
    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      shell,
      processes: scriptedProcesses().processes,
    });

    expect(launch.executable).toBe("/opt/homebrew/bin/fish");
    expect(launch.arguments).toEqual(["-fish"]);
    expect(launch.workingDirectory).toBe("/Users/x/code/.worktrees/feature");
    expect(launch.initialSize).toEqual(DEFAULT_INITIAL_SIZE);
  });

  test("a bare command is resolved on the captured PATH, not ours", async () => {
    const fake = scriptedProcesses({ which: { claude: "/opt/homebrew/bin/claude" } });

    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      command: ["claude"],
      shell,
      processes: fake.processes,
    });

    expect(fake.whichCalls).toEqual([{ executable: "claude", path: "/opt/homebrew/bin:/usr/bin" }]);
    expect(launch.executable).toBe("/opt/homebrew/bin/claude");
    expect(launch.arguments).toEqual(["claude"]);
  });

  test("an absolute command is taken as written", async () => {
    const fake = scriptedProcesses();

    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      command: ["/usr/bin/env", "-0"],
      shell,
      processes: fake.processes,
    });

    expect(launch.executable).toBe("/usr/bin/env");
    expect(launch.arguments).toEqual(["/usr/bin/env", "-0"]);
    expect(fake.whichCalls).toEqual([]);
  });

  test("a command that is not installed is refused by name", async () => {
    const thrown = await rejection(
      resolveTerminalLaunch({
        session,
        terminal: descriptor(),
        command: ["claude"],
        shell,
        processes: scriptedProcesses({ which: {} }).processes,
      }),
    );

    expect(thrown).toBeInstanceOf(ExecutableUnavailable);

    if (!(thrown instanceof ExecutableUnavailable)) throw thrown;

    expect(thrown.summary).toBe("claude isn't installed.");
  });

  test("the terminal capabilities and the JANELA namespace win over the captured environment", async () => {
    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      project,
      shell: {
        ...shell,
        resolved: {
          PATH: "/opt/homebrew/bin:/usr/bin",
          TERM: "vt100",
          ConEmuANSI: "OFF",
          JANELA_SESSION_NAME: "not this",
          ANTHROPIC_LOG: "debug",
          EDITOR: "hx",
        },
      },
      processes: scriptedProcesses().processes,
    });

    expect(launch.environment["TERM"]).toBe("xterm-256color");
    expect(launch.environment["ConEmuANSI"]).toBe("ON");
    expect(launch.environment["JANELA_SESSION_NAME"]).toBe("feature");
    expect(launch.environment["JANELA_PROJECT"]).toBe("janela");
    expect(launch.environment["JANELA_PROJECT_DIRECTORY"]).toBe("/Users/x/code/janela");
    expect(launch.environment["ANTHROPIC_LOG"]).toBe("debug");
    expect(launch.environment["EDITOR"]).toBe("hx");
  });

  test("a working-directory override wins over the session directory", async () => {
    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor({
        workingDirectoryOverride: "/Users/x/code/.worktrees/feature/packages/db" as AbsolutePath,
      }),
      shell,
      processes: scriptedProcesses().processes,
    });

    expect(launch.workingDirectory).toBe("/Users/x/code/.worktrees/feature/packages/db");
  });

  test("a script is handed to the login shell as one -c argument, with no PATH lookup", async () => {
    const fake = scriptedProcesses();
    const script = 'cp "$JANELA_PROJECT_DIRECTORY/.env" .env\npnpm install';

    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      project,
      script,
      automationEvent: "worktreeCreated",
      shell,
      processes: fake.processes,
    });

    expect(launch.executable).toBe(shell.loginShell);
    expect(launch.arguments).toEqual([shell.loginShell, "-c", script]);
    expect(launch.workingDirectory).toBe(session.directory);
    expect(launch.environment["JANELA_AUTOMATION_EVENT"]).toBe("worktreeCreated");
    expect(fake.whichCalls).toEqual([]);
  });

  test("every launch names JANELA_TTY, which is what a harness hook writes to", async () => {
    const loginShell = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      shell,
      processes: scriptedProcesses().processes,
    });
    const fromArgv = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      command: ["/usr/bin/env", "-0"],
      shell,
      processes: scriptedProcesses().processes,
    });

    expect(loginShell.replicaPathVariable).toBe("JANELA_TTY");
    expect(fromArgv.replicaPathVariable).toBe("JANELA_TTY");
  });
});
