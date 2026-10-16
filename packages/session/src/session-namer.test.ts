import { describe, expect, test } from "bun:test";

import type { Session, SessionID, SessionNameOrigin, SessionNaming } from "@janela/core";
import { absolutePath, emptyLayout, newSessionID, now } from "@janela/core";
import type { SettingsRepository } from "@janela/db";
import type { ProcessOutcome, ProcessRequest, ProcessRunning } from "@janela/support/process";

import { NamerModelsUnavailable } from "./errors.ts";
import {
  MAX_CONCURRENT_NAMERS,
  NAMER_SYSTEM_PROMPT,
  createSessionNamer,
  namerEnvironment,
  namerInvocation,
  type SessionNamer,
} from "./session-namer.ts";
import { REFRESH_AFTER_MILLISECONDS, REFRESH_AFTER_PROMPTS } from "./session-naming-policy.ts";

interface Harness {
  readonly namer: SessionNamer;
  readonly runs: ProcessRequest[];
  readonly stored: SessionNaming[];
  readonly sessions: Map<SessionID, Session>;
  readonly clock: { now: number };
  reply(text: string | Error, exitCode: number): void;
  hold(): () => void;
}

const PROMPT = "the sidebar flickers when I switch sessions quickly";

const CLAUDE: SessionNaming = { kind: "agent", agent: "claude" };

function session(nameOrigin: SessionNameOrigin, name = "feature-branch"): Session {
  return {
    id: newSessionID(),
    name,
    nameOrigin,
    directory: absolutePath("/tmp/janela-namer"),
    backing: { kind: "folder" },
    terminals: [],
    layout: emptyLayout,
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
  };
}

function outcome(standardOutput: string, exitCode = 0): ProcessOutcome {
  return {
    standardOutput,
    standardError: "",
    exitCode,
    succeeded: exitCode === 0,
    timedOut: false,
  };
}

async function harness(
  naming: SessionNaming = CLAUDE,
  available: readonly string[] = ["claude", "codex", "omp"],
): Promise<Harness> {
  const runs: ProcessRequest[] = [];
  const stored: SessionNaming[] = [];
  const sessions = new Map<SessionID, Session>();
  const clock = { now: 1_000_000 };
  let next: string | Error = "Sidebar flicker";
  let nextExit = 0;
  let gate: Promise<undefined> | undefined;

  const processes: ProcessRunning = {
    async run(request: ProcessRequest): Promise<ProcessOutcome> {
      runs.push(request);
      await gate;

      if (next instanceof Error) throw next;

      return outcome(next, nextExit);
    },
    which: (executable: string) =>
      Promise.resolve(available.includes(executable) ? `/opt/bin/${executable}` : undefined),
  };

  const settings: SettingsRepository = {
    sessionNaming: () => Promise.resolve(naming),
    saveSessionNaming: (value) => {
      stored.push(value);

      return Promise.resolve();
    },
  };

  const namer = createSessionNamer({
    sessions: {
      find: (id) => sessions.get(id),
      nameAutomatically: (id, name) => {
        const found = sessions.get(id);

        if (found === undefined || found.nameOrigin === "user" || found.name === name) {
          return Promise.resolve(false);
        }

        found.name = name;
        found.nameOrigin = "automatic";

        return Promise.resolve(true);
      },
    },
    settings,
    processes,
    environment: { PATH: "/opt/bin", HOME: "/Users/x", JANELA_TTY: "/dev/ttys004" },
    workingDirectory: "/tmp",
    clock: () => clock.now,
  });

  await namer.load();

  return {
    namer,
    runs,
    stored,
    sessions,
    clock,
    reply(text, exitCode): void {
      next = text;
      nextExit = exitCode;
    },
    hold(): () => void {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      gate = promise;

      return () => {
        gate = undefined;
        resolve(undefined);
      };
    },
  };
}

function add(fixture: Harness, value: Session): Session {
  fixture.sessions.set(value.id, value);

  return value;
}

describe("namerInvocation", () => {
  test("Claude Code runs print-only, as a namer rather than a coding agent, with no tools, settings, MCP or saved session", () => {
    expect(namerInvocation(CLAUDE, "name this")).toEqual({
      executable: "claude",
      arguments: [
        "--print",
        "--model",
        "haiku",
        "--system-prompt",
        NAMER_SYSTEM_PROMPT,
        "--tools",
        "",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "name this",
      ],
    });
  });

  test("a chosen model replaces the default, and a namer without a default takes none", () => {
    expect(
      namerInvocation({ kind: "agent", agent: "claude", model: "sonnet" }, "x").arguments,
    ).toContain("sonnet");

    expect(namerInvocation({ kind: "agent", agent: "codex" }, "x").arguments).not.toContain(
      "--model",
    );

    expect(namerInvocation({ kind: "agent", agent: "omp", model: "fast" }, "x").arguments).toEqual([
      "--print",
      "--no-tools",
      "--no-session",
      "--model",
      "fast",
      "x",
    ]);
  });
});

describe("namerInvocation with a reasoning effort", () => {
  test("each agent takes the effort through its own flag", () => {
    expect(
      namerInvocation({ kind: "agent", agent: "claude", effort: "low" }, "x").arguments,
    ).toEqual(expect.arrayContaining(["--effort", "low"]));

    expect(
      namerInvocation({ kind: "agent", agent: "codex", effort: "low" }, "x").arguments,
    ).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="low"']));

    expect(
      namerInvocation({ kind: "agent", agent: "omp", effort: "minimal" }, "x").arguments,
    ).toContain("--thinking=minimal");
  });

  test("no effort adds no flag", () => {
    expect(namerInvocation(CLAUDE, "x").arguments).not.toContain("--effort");
  });
});

describe("namerEnvironment", () => {
  test("never hands the namer a terminal to report into", () => {
    expect(namerEnvironment({ PATH: "/bin", JANELA_TTY: "/dev/ttys001" })).toEqual({
      PATH: "/bin",
    });
  });
});

describe("models", () => {
  test("asks the agent itself, bounded and timed, and returns what it described", async () => {
    const fixture = await harness();

    fixture.reply(
      JSON.stringify({
        models: [
          {
            slug: "gpt-small",
            display_name: "GPT Small",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          { slug: "internal", visibility: "hide" },
        ],
      }),
      0,
    );

    const catalog = await fixture.namer.models("codex");

    expect(catalog).toEqual({
      agent: "codex",
      models: [{ id: "gpt-small", name: "GPT Small", efforts: ["low", "high"] }],
    });

    const [run] = fixture.runs;

    expect(run?.arguments).toEqual(["debug", "models"]);
    expect(run?.maximumOutputBytes).toBeGreaterThan(0);
    expect(run?.timeoutMs).toBeGreaterThan(0);
  });

  test("an agent missing from PATH is a stated failure, not an empty list", async () => {
    const fixture = await harness(CLAUDE, ["claude"]);

    await expect(fixture.namer.models("omp")).rejects.toThrow(NamerModelsUnavailable);
    expect(fixture.runs).toHaveLength(0);
  });

  test("output the agent did not shape as a catalog is a stated failure", async () => {
    const fixture = await harness();

    fixture.reply("not json", 0);

    await expect(fixture.namer.models("codex")).rejects.toThrow(NamerModelsUnavailable);
  });
});

describe("createSessionNamer", () => {
  test("names a session after its first substantive prompt", async () => {
    const fixture = await harness();
    const value = add(fixture, session("derived"));

    await fixture.namer.promptSubmitted(value.id, "yes");

    expect(fixture.runs).toHaveLength(0);

    await fixture.namer.promptSubmitted(value.id, PROMPT);

    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]?.executable).toBe("/opt/bin/claude");
    expect(fixture.runs[0]?.workingDirectory).toBe("/tmp");
    expect(fixture.runs[0]?.environment).toEqual({ PATH: "/opt/bin", HOME: "/Users/x" });
    expect(fixture.runs[0]?.arguments.at(-1)).toContain(`1. ${PROMPT}`);
    expect(value).toMatchObject({ name: "Sidebar flicker", nameOrigin: "automatic" });
  });

  test("does nothing at all while naming is off, and remembers nothing", async () => {
    const fixture = await harness({ kind: "off" });
    const value = add(fixture, session("derived"));

    await fixture.namer.promptSubmitted(value.id, PROMPT);
    await fixture.namer.configure(CLAUDE);
    await fixture.namer.promptSubmitted(value.id, "and also the tests are failing now");

    expect(fixture.runs).toHaveLength(1);
    expect(fixture.runs[0]?.arguments.at(-1)).not.toContain(PROMPT);
    expect(fixture.stored).toEqual([CLAUDE]);
  });

  test("never touches a name the user gave", async () => {
    const fixture = await harness();
    const value = add(fixture, session("user", "Login rework"));

    for (let index = 0; index < REFRESH_AFTER_PROMPTS * 2; index += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await fixture.namer.promptSubmitted(value.id, `${PROMPT} ${index}`);
    }

    expect(fixture.runs).toHaveLength(0);
    expect(value.name).toBe("Login rework");
  });

  test("a rename by hand while the namer runs wins", async () => {
    const fixture = await harness();
    const value = add(fixture, session("derived"));
    const release = fixture.hold();
    const naming = fixture.namer.promptSubmitted(value.id, PROMPT);

    value.name = "Login rework";
    value.nameOrigin = "user";
    release();
    await naming;

    expect(value).toMatchObject({ name: "Login rework", nameOrigin: "user" });
  });

  test("a vague or failed first attempt is retried on the next prompt", async () => {
    const fixture = await harness();
    const value = add(fixture, session("derived"));

    fixture.reply('""', 0);
    await fixture.namer.promptSubmitted(value.id, PROMPT);
    fixture.reply("boom", 1);
    await fixture.namer.promptSubmitted(value.id, `${PROMPT} again`);
    fixture.reply("Sidebar flicker", 0);
    await fixture.namer.promptSubmitted(value.id, `${PROMPT} once more`);

    expect(fixture.runs).toHaveLength(3);
    expect(value.name).toBe("Sidebar flicker");
  });

  test("refreshes an automatic name only after enough prompts and time, offering it back", async () => {
    const fixture = await harness();
    const value = add(fixture, session("derived"));

    await fixture.namer.promptSubmitted(value.id, PROMPT);

    for (let index = 0; index < REFRESH_AFTER_PROMPTS; index += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await fixture.namer.promptSubmitted(value.id, `now the login page is broken ${index}`);
    }

    expect(fixture.runs).toHaveLength(1);

    fixture.clock.now += REFRESH_AFTER_MILLISECONDS;
    fixture.reply("Login page fix", 0);
    await fixture.namer.promptSubmitted(value.id, "the login page still redirects twice");

    expect(fixture.runs).toHaveLength(2);
    expect(fixture.runs[1]?.arguments.at(-1)).toContain('called "Sidebar flicker"');
    expect(value.name).toBe("Login page fix");
  });

  test("a missing namer binary is a quiet failure, never a crash", async () => {
    const fixture = await harness(CLAUDE, []);
    const value = add(fixture, session("derived"));

    await fixture.namer.promptSubmitted(value.id, PROMPT);

    expect(fixture.runs).toHaveLength(0);
    expect(value.name).toBe("feature-branch");
  });

  test("a namer that throws leaves the name alone", async () => {
    const fixture = await harness();
    const value = add(fixture, session("derived"));

    fixture.reply(new Error("spawn failed"), 0);
    await fixture.namer.promptSubmitted(value.id, PROMPT);

    expect(value.name).toBe("feature-branch");
  });

  test("one namer per session, and a bounded number at once", async () => {
    const fixture = await harness();
    const values = Array.from({ length: MAX_CONCURRENT_NAMERS + 1 }, () =>
      add(fixture, session("derived")),
    );

    const release = fixture.hold();
    const first = values[0];

    if (first === undefined) throw new Error("no session");

    const pending = [
      fixture.namer.promptSubmitted(first.id, PROMPT),
      fixture.namer.promptSubmitted(first.id, `${PROMPT} twice`),
      ...values.slice(1).map((value) => fixture.namer.promptSubmitted(value.id, PROMPT)),
    ];

    await Promise.resolve();
    release();
    await Promise.all(pending);

    expect(fixture.runs).toHaveLength(MAX_CONCURRENT_NAMERS);
  });

  test("reports which namers are on PATH, and the model each uses by default", async () => {
    const fixture = await harness(CLAUDE, ["claude", "omp"]);

    expect(await fixture.namer.overview()).toEqual({
      naming: CLAUDE,
      namers: [
        {
          id: "claude",
          name: "Claude Code",
          executable: "claude",
          isAvailable: true,
          defaultModel: "haiku",
        },
        { id: "codex", name: "Codex", executable: "codex", isAvailable: false },
        { id: "omp", name: "Oh My Pi", executable: "omp", isAvailable: true },
      ],
    });
  });
});
