import { describe, expect, test } from "bun:test";

import { absolutePath, instant } from "@janela/core";
import type { Project, Session } from "@janela/core";

import {
  DEFAULT_FORGE_TIMEOUT_MS,
  FORGE_REFRESH_INTERVAL_MS,
  forgeService,
  MAXIMUM_FORGE_OUTPUT_CHARACTERS,
} from "./forge-service.ts";
import type { ForgeServing } from "./index.ts";
import {
  fakeProject,
  fakeSession,
  manualClock,
  recordingLogger,
  scriptedProcesses,
  type ManualClock,
  type RecordedLog,
  type ScriptedOutcome,
} from "./test-fakes.ts";

const environment = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" };
const ghPath = "/opt/homebrew/bin/gh";
const glabPath = "/opt/homebrew/bin/glab";

const GH_FIELDS = "number,title,state,isDraft,url,statusCheckRollup";

/** Content that must never reach a log record. */
const title = "feat(pty): the pseudo-terminal";
const url = "https://github.com/suiramdev/janela/pull/42";

const ghPullRequest = (overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    number: 42,
    title,
    state: "MERGED",
    isDraft: false,
    url,
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", state: null },
    ],
    ...overrides,
  });

const glabMergeRequest = (overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    iid: 42,
    title,
    state: "opened",
    draft: true,
    web_url: url,
    head_pipeline: { status: "failed" },
    ...overrides,
  });

interface Harness {
  readonly forge: ForgeServing;
  readonly invocations: readonly {
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  }[];
  readonly whichCalls: readonly { readonly executable: string; readonly path: string }[];
  readonly records: readonly RecordedLog[];
  readonly clock: ManualClock;
  hold(): () => void;
}

function harness(options?: {
  readonly outcomes?: readonly ScriptedOutcome[];
  readonly which?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Harness {
  const processes = scriptedProcesses({
    ...(options?.outcomes === undefined ? {} : { outcomes: options.outcomes }),
    which: options?.which ?? { gh: ghPath, glab: glabPath },
  });
  const { logger, records } = recordingLogger();
  const clock = manualClock();

  return {
    forge: forgeService({
      environment,
      processes: processes.processes,
      log: logger,
      clock: clock.now,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
    invocations: processes.invocations,
    whichCalls: processes.whichCalls,
    records,
    clock,
    hold: processes.hold,
  };
}

/** The single class a failing read logged. */
const failures = (records: readonly RecordedLog[]): readonly unknown[] =>
  records
    .filter((record) => record.message === "forge read failed")
    .map((r) => r.fields?.["failure"]);

const project = (overrides?: Partial<Project>): Project => fakeProject(overrides);
const session = (overrides?: Partial<Session>): Session => fakeSession(overrides);

describe("state: what we ask gh", () => {
  test("the argv, the executable, the directory and the timeout are pinned", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }] });
    const workingSession = session();

    await h.forge.state({ project: project(), session: workingSession });

    expect(h.whichCalls).toEqual([{ executable: "gh", path: environment.PATH }]);
    expect(h.invocations).toEqual([
      {
        executable: ghPath,
        arguments: ["pr", "view", "feat/x", "--json", GH_FIELDS],
        workingDirectory: workingSession.directory,
        environment,
        timeoutMs: DEFAULT_FORGE_TIMEOUT_MS,
      },
    ]);
  });

  test("a session in the project directory names no branch, so the CLI resolves one", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }] });
    const owning = project();
    const simple = session({ directory: owning.directory, backing: { kind: "projectDirectory" } });

    await h.forge.state({ project: owning, session: simple });

    expect(h.invocations[0]?.arguments).toEqual(["pr", "view", "--json", GH_FIELDS]);
    expect(h.invocations[0]?.workingDirectory).toBe(owning.directory);
  });

  test("a caller's timeout reaches the process", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }], timeoutMs: 250 });

    await h.forge.state({ project: project(), session: session() });

    expect(h.invocations[0]?.timeoutMs).toBe(250);
  });
});

describe("state: decoding gh", () => {
  test("the verified gh shape becomes a ForgeState stamped with our clock", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }] });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state).toEqual({
      host: "gitHub",
      pullRequest: { number: 42, title, state: "merged", isDraft: false, url },
      checks: "passing",
      refreshedAt: instant(new Date(h.clock.now())),
    });
    expect(h.records).toEqual([
      {
        level: "debug",
        message: "forge read",
        fields: { forge: "gitHub", cli: "gh", subcommand: "pr view" },
      },
    ]);
  });

  test("an open draft stays open and draft", async () => {
    const h = harness({
      outcomes: [{ standardOutput: ghPullRequest({ state: "OPEN", isDraft: true }) }],
    });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.pullRequest?.state).toBe("open");
    expect(state?.pullRequest?.isDraft).toBe(true);
  });

  test("a closed pull request is closed", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest({ state: "CLOSED" }) }] });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.pullRequest?.state).toBe("closed");
  });

  test("one failure outranks a success and a run still going", async () => {
    const h = harness({
      outcomes: [
        {
          standardOutput: ghPullRequest({
            statusCheckRollup: [
              { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", state: null },
              { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null, state: null },
              { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE", state: null },
            ],
          }),
        },
      ],
    });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.checks).toBe("failing");
  });

  test("a pending status context outranks a passing check run", async () => {
    const h = harness({
      outcomes: [
        {
          standardOutput: ghPullRequest({
            statusCheckRollup: [
              { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", state: null },
              { __typename: "StatusContext", state: "PENDING" },
            ],
          }),
        },
      ],
    });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.checks).toBe("running");
  });

  test("a failed status context fails the rollup", async () => {
    const h = harness({
      outcomes: [
        {
          standardOutput: ghPullRequest({
            statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }],
          }),
        },
      ],
    });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.checks).toBe("failing");
  });

  test("no checks at all is none, not passing", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest({ statusCheckRollup: [] }) }] });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.checks).toBe("none");
  });

  test("output of exactly the cap is still an answer", async () => {
    // The boundary, both sides: the case list above refuses one character more.
    const padding = MAXIMUM_FORGE_OUTPUT_CHARACTERS - ghPullRequest().length;
    const standardOutput = ghPullRequest({ title: `${title}${"y".repeat(padding)}` });
    expect(standardOutput).toHaveLength(MAXIMUM_FORGE_OUTPUT_CHARACTERS);
    const h = harness({ outcomes: [{ standardOutput }] });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state?.checks).toBe("passing");
  });
});

describe("state: decoding glab", () => {
  const gitLab = { git: { forge: "gitLab" as const, defaultBranch: "main" } };

  test("the argv is glab's, which has no field list", async () => {
    const h = harness({ outcomes: [{ standardOutput: glabMergeRequest() }] });

    await h.forge.state({ project: project(gitLab), session: session() });

    expect(h.whichCalls).toEqual([{ executable: "glab", path: environment.PATH }]);
    expect(h.invocations[0]?.arguments).toEqual(["mr", "view", "feat/x", "--output", "json"]);
  });

  test("iid, draft, web_url and a failed pipeline map across", async () => {
    const h = harness({ outcomes: [{ standardOutput: glabMergeRequest() }] });

    const state = await h.forge.state({ project: project(gitLab), session: session() });

    expect(state).toEqual({
      host: "gitLab",
      pullRequest: { number: 42, title, state: "open", isDraft: true, url },
      checks: "failing",
      refreshedAt: instant(new Date(h.clock.now())),
    });
  });

  test("a locked merge request is still open to a reader", async () => {
    const h = harness({ outcomes: [{ standardOutput: glabMergeRequest({ state: "locked" }) }] });

    const state = await h.forge.state({ project: project(gitLab), session: session() });

    expect(state?.pullRequest?.state).toBe("open");
  });

  test("no head pipeline is none", async () => {
    const h = harness({
      outcomes: [{ standardOutput: glabMergeRequest({ head_pipeline: null }) }],
    });

    const state = await h.forge.state({ project: project(gitLab), session: session() });

    expect(state?.checks).toBe("none");
  });

  test("a running pipeline is running and a successful one passes", async () => {
    const h = harness({
      outcomes: [
        { standardOutput: glabMergeRequest({ head_pipeline: { status: "running" } }) },
        { standardOutput: glabMergeRequest({ head_pipeline: { status: "success" } }) },
      ],
    });

    const first = await h.forge.state({ project: project(gitLab), session: session() });
    const second = await h.forge.state({ project: project(gitLab), session: session() });

    expect(first?.checks).toBe("running");
    expect(second?.checks).toBe("passing");
  });
});

describe("state: every failure is undefined plus a logged class", () => {
  const cases: readonly {
    readonly name: string;
    readonly outcome: ScriptedOutcome;
    readonly failure: string;
    readonly level?: RecordedLog["level"];
  }[] = [
    {
      name: "logged out",
      outcome: {
        exitCode: 1,
        succeeded: false,
        standardError: "To get started with GitHub CLI, please run:  gh auth login",
      },
      failure: "notLoggedIn",
    },
    {
      name: "rate limited",
      outcome: { exitCode: 1, succeeded: false, standardError: "API rate limit exceeded" },
      failure: "rateLimited",
    },
    {
      name: "unreachable host",
      outcome: {
        exitCode: 1,
        succeeded: false,
        standardError: "dial tcp: lookup api.github.com: no such host",
      },
      failure: "networkFailure",
    },
    {
      name: "no pull request for the branch",
      outcome: {
        exitCode: 1,
        succeeded: false,
        standardError: 'no pull requests found for branch "feat/x"',
      },
      failure: "noPullRequest",
    },
    {
      name: "a renamed json field",
      outcome: {
        exitCode: 1,
        succeeded: false,
        standardError: 'Unknown JSON field: "statusCheckRollup"',
      },
      failure: "unknownShape",
      level: "warning",
    },
    {
      name: "an exit we cannot classify",
      outcome: { exitCode: 1, succeeded: false, standardError: "boom" },
      failure: "exit",
    },
    {
      name: "the timeout killed it",
      outcome: { exitCode: -1, succeeded: false, timedOut: true },
      failure: "timeout",
      level: "warning",
    },
    {
      name: "stdout that is not json",
      outcome: { standardOutput: "not json" },
      failure: "malformedOutput",
      level: "warning",
    },
    {
      name: "json missing a field we asked for",
      outcome: { standardOutput: JSON.stringify({ number: 42, title, state: "OPEN", url }) },
      failure: "unknownShape",
      level: "warning",
    },
    {
      name: "a state we do not know",
      outcome: { standardOutput: ghPullRequest({ state: "SUPERSEDED" }) },
      failure: "unknownShape",
      level: "warning",
    },
    {
      name: "a rollup element type we have never seen",
      outcome: {
        standardOutput: ghPullRequest({
          statusCheckRollup: [{ __typename: "Deployment", state: "SUCCESS" }],
        }),
      },
      failure: "unknownShape",
      level: "warning",
    },
    {
      name: "output too large to be an answer",
      outcome: { standardOutput: "x".repeat(MAXIMUM_FORGE_OUTPUT_CHARACTERS + 1) },
      failure: "outputTooLarge",
      level: "warning",
    },
    { name: "the process never started", outcome: new Error("ENOENT"), failure: "spawnFailure" },
  ];

  for (const scenario of cases) {
    test(`${scenario.name} reads as absence, logging ${scenario.failure}`, async () => {
      const h = harness({ outcomes: [scenario.outcome] });
      const workingSession = session();

      const state = await h.forge.state({ project: project(), session: workingSession });

      expect(state).toBeUndefined();
      expect(h.records).toHaveLength(1);
      expect(h.records[0]?.level).toBe(scenario.level ?? "info");
      expect(h.records[0]?.message).toBe("forge read failed");
      expect(h.records[0]?.fields?.["failure"]).toBe(scenario.failure);

      const logged = JSON.stringify(h.records);
      expect(logged).not.toContain(title);
      expect(logged).not.toContain(url);
      expect(logged).not.toContain("feat/x");
      expect(logged).not.toContain(workingSession.directory);
      expect(logged).not.toContain("auth login");
      expect(logged).not.toContain("boom");
      expect(logged).not.toContain("api.github.com");
    });
  }

  test("glab's error json arrives on stdout, and is still a missing merge request", async () => {
    const h = harness({
      outcomes: [
        {
          exitCode: 1,
          succeeded: false,
          standardOutput:
            '{"error":{"message":"failed to get merge request 999999: 404 Not Found"}}',
          standardError: "",
        },
      ],
    });

    const state = await h.forge.state({
      project: project({ git: { forge: "gitLab", defaultBranch: "main" } }),
      session: session(),
    });

    expect(state).toBeUndefined();
    expect(failures(h.records)).toEqual(["noPullRequest"]);
    expect(h.records[0]?.fields?.["cli"]).toBe("glab");
  });

  test("a non-zero exit carries its code, which is a shape not content", async () => {
    const h = harness({ outcomes: [{ exitCode: 3, succeeded: false, standardError: "boom" }] });

    await h.forge.state({ project: project(), session: session() });

    expect(h.records[0]?.fields).toEqual({
      forge: "gitHub",
      cli: "gh",
      subcommand: "pr view",
      failure: "exit",
      exitCode: 3,
    });
  });

  test("no gh on PATH runs no process at all", async () => {
    const h = harness({ which: {} });

    const state = await h.forge.state({ project: project(), session: session() });

    expect(state).toBeUndefined();
    expect(h.invocations).toEqual([]);
    expect(failures(h.records)).toEqual(["missingBinary"]);
  });
});

describe("state: when we must not look", () => {
  test("a project with no recognised forge is silence, not a read", async () => {
    const h = harness();
    const folder = project();
    delete folder.git;

    const state = await h.forge.state({ project: folder, session: session() });

    expect(state).toBeUndefined();
    expect(h.whichCalls).toEqual([]);
    expect(h.invocations).toEqual([]);
    expect(h.records).toEqual([]);
  });

  test("the setting off is silence, not a read", async () => {
    const h = harness();
    const disabled = project();
    disabled.settings = { ...disabled.settings, isForgeEnabled: false };

    const state = await h.forge.state({ project: disabled, session: session() });

    expect(state).toBeUndefined();
    expect(h.whichCalls).toEqual([]);
    expect(h.invocations).toEqual([]);
    expect(h.records).toEqual([]);
  });
});

describe("state: the cache", () => {
  test("a second read inside the interval is the same answer and no process", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }] });
    const owning = project();
    const working = session();

    const first = await h.forge.state({ project: owning, session: working });
    h.clock.advance(FORGE_REFRESH_INTERVAL_MS - 1);
    const second = await h.forge.state({ project: owning, session: working });

    expect(h.invocations).toHaveLength(1);
    expect(second).toBe(first);
  });

  test("the interval elapsing re-reads", async () => {
    const h = harness({
      outcomes: [{ standardOutput: ghPullRequest() }, { standardOutput: ghPullRequest() }],
    });
    const owning = project();
    const working = session();

    await h.forge.state({ project: owning, session: working });
    h.clock.advance(FORGE_REFRESH_INTERVAL_MS);
    await h.forge.state({ project: owning, session: working });

    expect(h.invocations).toHaveLength(2);
  });

  test("a failure is cached too, so a logged-out user is asked once a minute", async () => {
    const h = harness({ which: {} });
    const owning = project();
    const working = session();

    await h.forge.state({ project: owning, session: working });
    await h.forge.state({ project: owning, session: working });

    expect(h.whichCalls).toHaveLength(1);
    expect(failures(h.records)).toEqual(["missingBinary"]);
  });

  test("two concurrent reads share one invocation", async () => {
    const h = harness({ outcomes: [{ standardOutput: ghPullRequest() }] });
    const owning = project();
    const working = session();
    const release = h.hold();

    const both = Promise.all([
      h.forge.state({ project: owning, session: working }),
      h.forge.state({ project: owning, session: working }),
    ]);
    release();
    const [first, second] = await both;

    expect(h.invocations).toHaveLength(1);
    expect(second).toBe(first);
  });

  test("another session is another entry", async () => {
    const h = harness({
      outcomes: [{ standardOutput: ghPullRequest() }, { standardOutput: ghPullRequest() }],
    });
    const owning = project();

    await h.forge.state({ project: owning, session: session() });
    await h.forge.state({ project: owning, session: session() });

    expect(h.invocations).toHaveLength(2);
  });
});

describe("isAvailable", () => {
  test("present and logged in", async () => {
    const h = harness({ outcomes: [{ exitCode: 0, succeeded: true }] });

    expect(await h.forge.isAvailable("gitHub")).toBe(true);
    expect(h.invocations[0]?.arguments).toEqual(["auth", "status"]);
    expect(h.invocations[0]?.executable).toBe(ghPath);
    expect(h.invocations[0]?.workingDirectory).toBe(environment.HOME);
  });

  test("not logged in hides the feature rather than showing a broken one", async () => {
    const h = harness({
      outcomes: [
        {
          exitCode: 1,
          succeeded: false,
          standardError:
            "You are not logged into any GitHub hosts. To get started with GitHub CLI, please run:  gh auth login",
        },
      ],
    });

    expect(await h.forge.isAvailable("gitHub")).toBe(false);
    expect(failures(h.records)).toEqual(["notLoggedIn"]);
    expect(h.records[0]?.fields?.["subcommand"]).toBe("auth status");
    expect(JSON.stringify(h.records)).not.toContain("auth login");
  });

  test("no binary answers false without spawning anything", async () => {
    const h = harness({ which: {} });

    expect(await h.forge.isAvailable("gitLab")).toBe(false);
    expect(h.invocations).toEqual([]);
    expect(failures(h.records)).toEqual(["missingBinary"]);
  });

  test("the answer is cached for the same interval", async () => {
    const h = harness({ outcomes: [{ exitCode: 0, succeeded: true }] });

    expect(await h.forge.isAvailable("gitHub")).toBe(true);
    expect(await h.forge.isAvailable("gitHub")).toBe(true);

    expect(h.invocations).toHaveLength(1);
  });
});

describe("pullRequestBranch", () => {
  test("gh is asked for the head branch and whether it is a fork", async () => {
    const h = harness({
      outcomes: [
        { standardOutput: JSON.stringify({ headRefName: "feat/x", isCrossRepository: false }) },
      ],
    });
    const owning = project();

    const branch = await h.forge.pullRequestBranch({ project: owning, number: 42 });

    expect(branch).toBe("feat/x");
    expect(h.invocations).toEqual([
      {
        executable: ghPath,
        arguments: ["pr", "view", "42", "--json", "headRefName,isCrossRepository"],
        workingDirectory: owning.directory,
        environment,
        timeoutMs: DEFAULT_FORGE_TIMEOUT_MS,
      },
    ]);
  });

  test("a fork's branch is not on origin, so we decline rather than invent one", async () => {
    const h = harness({
      outcomes: [
        { standardOutput: JSON.stringify({ headRefName: "feat/x", isCrossRepository: true }) },
      ],
    });

    const branch = await h.forge.pullRequestBranch({ project: project(), number: 42 });

    expect(branch).toBeUndefined();
    expect(failures(h.records)).toEqual(["crossRepository"]);
  });

  test("glab answers with its source branch", async () => {
    const h = harness({
      outcomes: [
        {
          standardOutput: JSON.stringify({
            source_branch: "feat/x",
            source_project_id: 44,
            target_project_id: 44,
          }),
        },
      ],
    });
    const owning = project({ git: { forge: "gitLab", defaultBranch: "main" } });

    const branch = await h.forge.pullRequestBranch({ project: owning, number: 42 });

    expect(branch).toBe("feat/x");
    expect(h.invocations[0]?.arguments).toEqual(["mr", "view", "42", "--output", "json"]);
  });

  test("a glab merge request from another project is a fork", async () => {
    const h = harness({
      outcomes: [
        {
          standardOutput: JSON.stringify({
            source_branch: "feat/x",
            source_project_id: 45,
            target_project_id: 44,
          }),
        },
      ],
    });

    const branch = await h.forge.pullRequestBranch({
      project: project({ git: { forge: "gitLab", defaultBranch: "main" } }),
      number: 42,
    });

    expect(branch).toBeUndefined();
    expect(failures(h.records)).toEqual(["crossRepository"]);
  });

  test("a missing pull request is absence, and never a branch name we made up", async () => {
    const h = harness({
      outcomes: [
        {
          exitCode: 1,
          succeeded: false,
          standardError:
            "GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)",
        },
      ],
    });

    const branch = await h.forge.pullRequestBranch({ project: project(), number: 999_999 });

    expect(branch).toBeUndefined();
    expect(failures(h.records)).toEqual(["noPullRequest"]);
  });

  test("an empty branch name is an API change, not an answer", async () => {
    const h = harness({
      outcomes: [{ standardOutput: JSON.stringify({ headRefName: "", isCrossRepository: false }) }],
    });

    const branch = await h.forge.pullRequestBranch({ project: project(), number: 42 });

    expect(branch).toBeUndefined();
    expect(failures(h.records)).toEqual(["unknownShape"]);
  });

  test("a project with no forge is asked nothing", async () => {
    const h = harness();
    const folder = project();
    delete folder.git;

    expect(await h.forge.pullRequestBranch({ project: folder, number: 42 })).toBeUndefined();
    expect(h.invocations).toEqual([]);
    expect(h.records).toEqual([]);
  });

  test("a user action is never served from a cache", async () => {
    const h = harness({
      outcomes: [
        { standardOutput: JSON.stringify({ headRefName: "feat/x", isCrossRepository: false }) },
        { standardOutput: JSON.stringify({ headRefName: "feat/y", isCrossRepository: false }) },
      ],
    });
    const owning = project();

    expect(await h.forge.pullRequestBranch({ project: owning, number: 42 })).toBe("feat/x");
    expect(await h.forge.pullRequestBranch({ project: owning, number: 42 })).toBe("feat/y");
    expect(h.invocations).toHaveLength(2);
  });
});

describe("defaults", () => {
  test("with no injected environment the CLI is still resolved from a PATH", async () => {
    const processes = scriptedProcesses({ which: {} });
    const service = forgeService({ processes: processes.processes });

    const state = await service.state({
      project: fakeProject(),
      session: fakeSession({ directory: absolutePath("/tmp") }),
    });

    expect(state).toBeUndefined();
    expect(processes.whichCalls[0]?.executable).toBe("gh");
    expect(processes.whichCalls[0]?.path.length).toBeGreaterThan(0);
  });
});
