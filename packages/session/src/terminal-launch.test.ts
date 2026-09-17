import { describe, expect, test } from "bun:test";

import type {
  AbsolutePath,
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import { emptyLayout, now } from "@janela/core";

import { LaunchProfileUnavailable } from "./errors.ts";
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
  settings: { worktreeRoot: { kind: "siblingDirectory" }, automation: [], isForgeEnabled: true },
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

const profile = (overrides: Partial<LaunchProfile> = {}): LaunchProfile => ({
  id: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" as LaunchProfileID,
  name: "Claude Code",
  iconName: "sparkles",
  command: ["claude"],
  environment: {},
  isAgent: true,
  isBuiltIn: true,
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
  test("no profile means the login shell, with a dash-prefixed argv[0]", async () => {
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

  test("a profile's executable is resolved on the captured PATH, not ours", async () => {
    const fake = scriptedProcesses({ which: { claude: "/opt/homebrew/bin/claude" } });

    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      profile: profile(),
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

  test("a profile whose tool is not installed names the profile, not the binary", async () => {
    const thrown = await rejection(
      resolveTerminalLaunch({
        session,
        terminal: descriptor(),
        profile: profile(),
        shell,
        processes: scriptedProcesses({ which: {} }).processes,
      }),
    );

    expect(thrown).toBeInstanceOf(LaunchProfileUnavailable);

    if (!(thrown instanceof LaunchProfileUnavailable)) throw thrown;

    expect(thrown.summary).toBe("Claude Code isn't installed.");
  });

  test("the terminal capabilities and the JANELA namespace win over a profile that sets them", async () => {
    const launch = await resolveTerminalLaunch({
      session,
      terminal: descriptor(),
      project,
      profile: profile({
        command: [],
        environment: {
          TERM: "vt100",
          ConEmuANSI: "OFF",
          JANELA_SESSION_NAME: "not this",
          ANTHROPIC_LOG: "debug",
        },
      }),
      shell,
      processes: scriptedProcesses().processes,
    });

    expect(launch.environment["TERM"]).toBe("xterm-256color");
    expect(launch.environment["ConEmuANSI"]).toBe("ON");
    expect(launch.environment["JANELA_SESSION_NAME"]).toBe("feature");
    expect(launch.environment["JANELA_PROJECT"]).toBe("janela");
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
});
