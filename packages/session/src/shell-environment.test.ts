import { describe, expect, test } from "bun:test";

import type { AbsolutePath, ProjectID, Session, SessionID, TerminalID } from "@janela/core";
import { emptyLayout } from "@janela/core";

import {
  DEFAULT_LOGIN_SHELL,
  janelaVariables,
  resolveShellEnvironment,
} from "./shell-environment.ts";
import { recordingLogger, scriptedProcesses } from "./test-fakes.ts";

const project = "1c8c9c8e-0e1a-4f2c-9a10-6c1c1f0b9f11" as ProjectID;

/** The environment a launchd-started daemon actually gets, plus a secret to leak. */
const daemonEnvironment = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/x",
  API_TOKEN: "s3cret-value",
  UNSET: undefined,
};

const session = (overrides?: Partial<Session>): Session => ({
  id: "0f6e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b" as SessionID,
  name: "feature",
  directory: "/Users/x/code/janela" as AbsolutePath,
  backing: { kind: "folder" },
  terminals: [],
  layout: emptyLayout,
  accent: "none",
  createdAt: "2026-01-02T03:04:05.000Z" as Session["createdAt"],
  lastActiveAt: "2026-01-02T03:04:05.000Z" as Session["lastActiveAt"],
  isPinned: false,
  ...overrides,
});

const terminal = "b2c3d4e5-f607-4182-93a4-b5c6d7e8f901" as TerminalID;

/** What `printf '\0JANELA_ENVIRONMENT\0'; /usr/bin/env -0` writes. */
function captureOutput(variables: Readonly<Record<string, string>>, greeting = ""): string {
  const entries = Object.entries(variables).map(([name, value]) => `${name}=${value}\0`);
  return `${greeting}\0JANELA_ENVIRONMENT\0${entries.join("")}`;
}

describe("resolveShellEnvironment", () => {
  test("captures the login shell's environment, greeting and all", async () => {
    const fake = scriptedProcesses({
      // No `dscl`, so resolution falls through to `$SHELL`.
      which: {},
      outcomes: [
        {
          standardOutput: captureOutput(
            {
              PATH: "/opt/homebrew/bin:/usr/bin:/bin",
              MULTI: "first\nsecond",
              SHLVL: "3",
              _: "/usr/bin/env",
              PWD: "/Users/x",
              OLDPWD: "/",
              "BASH_FUNC_x%%": "() { :; }",
            },
            "Welcome to fish, the friendly interactive shell\n",
          ),
        },
      ],
    });

    const shell = await resolveShellEnvironment({
      processEnvironment: { ...daemonEnvironment, SHELL: "/opt/homebrew/bin/fish" },
      processes: fake.processes,
      timeoutMs: 5,
    });

    expect(shell.loginShell).toBe("/opt/homebrew/bin/fish");
    expect(shell.loginShellArguments()).toEqual(["-fish"]);
    // A `PATH` from the user's dotfiles is the entire point of the exercise.
    expect(shell.resolved["PATH"]).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    // NUL-delimited so a value with a newline survives; a line-based parse would
    // have turned this into two variables, one of them nonsense.
    expect(shell.resolved["MULTI"]).toBe("first\nsecond");
    expect(Object.keys(shell.resolved).toSorted()).toEqual(["MULTI", "PATH"]);

    const invocation = fake.invocations[0];
    expect(invocation?.executable).toBe("/opt/homebrew/bin/fish");
    // Separate flags, not `-ilc`: fish's option parser rejects the bundled form.
    expect(invocation?.arguments).toEqual([
      "-i",
      "-l",
      "-c",
      "printf '\\0JANELA_ENVIRONMENT\\0'; /usr/bin/env -0",
    ]);
    expect(invocation?.workingDirectory).toBe("/Users/x");
    expect(invocation?.environment).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      API_TOKEN: "s3cret-value",
      SHELL: "/opt/homebrew/bin/fish",
    });
  });

  test("a capture that times out falls back to our own environment and logs a shape", async () => {
    const { logger, records } = recordingLogger();
    const fake = scriptedProcesses({
      which: {},
      outcomes: [{ succeeded: false, exitCode: -1, timedOut: true }],
    });

    const shell = await resolveShellEnvironment({
      processEnvironment: daemonEnvironment,
      processes: fake.processes,
      log: logger,
      timeoutMs: 5,
    });

    expect(shell.resolved).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/x",
      API_TOKEN: "s3cret-value",
    });
    expect(records).toEqual([
      {
        level: "warning",
        message: "shell environment capture failed",
        fields: { shell: "zsh", exitCode: -1, timedOut: true, reason: "timeout" },
      },
    ]);
    // The log is the daemon's, and the daemon's log is the user's private data.
    expect(JSON.stringify(records)).not.toContain("s3cret-value");
  });

  test("a shell that cannot be spawned is not fatal", async () => {
    const { logger, records } = recordingLogger();
    const fake = scriptedProcesses({
      which: {},
      outcomes: [new Error("ENOENT")],
    });

    const shell = await resolveShellEnvironment({
      processEnvironment: daemonEnvironment,
      processes: fake.processes,
      log: logger,
    });

    expect(shell.resolved["PATH"]).toBe("/usr/bin:/bin");
    expect(records.map((record) => record.fields?.["reason"])).toEqual(["spawn"]);
  });

  test("output without the marker is not an environment", async () => {
    const { logger, records } = recordingLogger();
    const fake = scriptedProcesses({
      which: {},
      // A shell whose rc file failed early and printed only its own complaint.
      outcomes: [{ standardOutput: "PATH=/opt/homebrew/bin\n" }],
    });

    const shell = await resolveShellEnvironment({
      processEnvironment: daemonEnvironment,
      processes: fake.processes,
      log: logger,
    });

    expect(shell.resolved["PATH"]).toBe("/usr/bin:/bin");
    expect(records.map((record) => record.fields?.["reason"])).toEqual(["marker-missing"]);
  });

  test("Directory Services answers before $SHELL does", async () => {
    const fake = scriptedProcesses({
      which: { dscl: "/usr/bin/dscl" },
      outcomes: [
        { standardOutput: "UserShell: /opt/homebrew/bin/fish\n" },
        { standardOutput: captureOutput({ PATH: "/opt/homebrew/bin" }) },
      ],
    });

    const shell = await resolveShellEnvironment({
      // What Bun reports: it does not call `getpwuid`, so the shell is a sentinel
      // and the name has to come from somewhere.
      account: () => ({ shell: "unknown", username: "ada" }),
      // `$SHELL` is only a hint — for a launchd daemon it is whatever launchd had.
      processEnvironment: { ...daemonEnvironment, SHELL: "/bin/bash" },
      processes: fake.processes,
    });

    expect(shell.loginShell).toBe("/opt/homebrew/bin/fish");
    expect(shell.loginShellArguments()).toEqual(["-fish"]);
    expect(fake.whichCalls[0]).toEqual({ executable: "dscl", path: "/usr/bin:/bin" });
    expect(fake.invocations[0]?.arguments).toEqual([".", "-read", "/Users/ada", "UserShell"]);
  });

  test("a runtime that reports getpwuid's shell is believed, and nothing is probed", async () => {
    const fake = scriptedProcesses({
      which: { dscl: "/usr/bin/dscl" },
      outcomes: [{ standardOutput: captureOutput({ PATH: "/usr/local/bin" }) }],
    });

    const shell = await resolveShellEnvironment({
      account: () => ({ shell: "/bin/bash", username: "ada" }),
      processEnvironment: daemonEnvironment,
      processes: fake.processes,
    });

    expect(shell.loginShell).toBe("/bin/bash");
    expect(fake.whichCalls).toEqual([]);
  });

  test("an unknown user is never asked about, because macOS answers anyway", async () => {
    const fake = scriptedProcesses({
      which: { dscl: "/usr/bin/dscl" },
      outcomes: [{ standardOutput: captureOutput({ PATH: "/opt/homebrew/bin" }) }],
    });

    const shell = await resolveShellEnvironment({
      // Bun's sentinel for both fields. Measured on this machine: `dscl . -read
      // /Users/unknown UserShell` prints `/usr/bin/false` and exits 0, which
      // looks exactly like a real shell and costs the user their environment.
      account: () => ({ shell: "unknown", username: "unknown" }),
      processEnvironment: { ...daemonEnvironment, SHELL: "/bin/zsh" },
      processes: fake.processes,
    });

    expect(fake.whichCalls).toEqual([]);
    expect(shell.loginShell).toBe("/bin/zsh");
  });

  test("$USER stands in when the runtime will not name the account", async () => {
    const fake = scriptedProcesses({
      which: { dscl: "/usr/bin/dscl" },
      outcomes: [
        { standardOutput: "UserShell: /bin/ksh\n" },
        { standardOutput: captureOutput({ PATH: "/usr/bin" }) },
      ],
    });

    const shell = await resolveShellEnvironment({
      account: () => ({ shell: "unknown", username: "unknown" }),
      processEnvironment: { ...daemonEnvironment, USER: "ada" },
      processes: fake.processes,
    });

    expect(shell.loginShell).toBe("/bin/ksh");
    expect(fake.invocations[0]?.arguments[2]).toBe("/Users/ada");
  });

  test("$SHELL is used when Directory Services is absent, and only when absolute", async () => {
    const withShell = await resolveShellEnvironment({
      processEnvironment: { SHELL: "/opt/homebrew/bin/fish" },
      processes: scriptedProcesses({ which: {} }).processes,
    });
    expect(withShell.loginShell).toBe("/opt/homebrew/bin/fish");

    const withNonsense = await resolveShellEnvironment({
      // A relative `$SHELL` is not something we can exec, and guessing is worse
      // than the documented default.
      processEnvironment: { SHELL: "fish" },
      processes: scriptedProcesses({ which: {} }).processes,
    });
    expect(withNonsense.loginShell).toBe(DEFAULT_LOGIN_SHELL);
    expect(withNonsense.loginShellArguments()).toEqual(["-zsh"]);
  });
});

describe("janelaVariables", () => {
  test("a standalone session gets four variables and no project or branch", () => {
    const variables = janelaVariables({ session: session(), terminalID: terminal });

    expect(Object.keys(variables).toSorted()).toEqual([
      "JANELA_SESSION_DIRECTORY",
      "JANELA_SESSION_ID",
      "JANELA_SESSION_NAME",
      "JANELA_TERMINAL_ID",
    ]);
    expect(variables["JANELA_SESSION_DIRECTORY"]).toBe("/Users/x/code/janela");
  });

  test("a worktree automation terminal gets the whole namespace", () => {
    const variables = janelaVariables({
      session: session({
        projectID: project,
        backing: {
          kind: "worktree",
          binding: {
            branch: "feature/x",
            path: "/Users/x/code/janela" as AbsolutePath,
            ownership: "managed",
            includedPaths: [],
          },
        },
      }),
      terminalID: terminal,
      projectName: "janela",
      automationEvent: "sessionStart",
    });

    expect(Object.keys(variables).toSorted()).toEqual([
      "JANELA_AUTOMATION_EVENT",
      "JANELA_BRANCH",
      "JANELA_PROJECT",
      "JANELA_SESSION_DIRECTORY",
      "JANELA_SESSION_ID",
      "JANELA_SESSION_NAME",
      "JANELA_TERMINAL_ID",
    ]);
    expect(variables["JANELA_BRANCH"]).toBe("feature/x");
  });

  test("a detached worktree has no branch, and says so by absence", () => {
    const variables = janelaVariables({
      session: session({
        projectID: project,
        backing: {
          kind: "worktree",
          binding: {
            path: "/Users/x/code/janela" as AbsolutePath,
            ownership: "adopted",
            includedPaths: [],
          },
        },
      }),
      terminalID: terminal,
    });

    // Absent rather than empty: `${JANELA_BRANCH}` in a script must not expand to
    // a branch whose name is the empty string.
    expect("JANELA_BRANCH" in variables).toBe(false);
  });
});
