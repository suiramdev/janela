import { describe, expect, test } from "bun:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { IntegrationID, IntegrationStatus } from "@janela/core";
import type { ProcessRunning } from "@janela/support/process";
import { temporaryDirectory } from "@janela/test-support";
import { Schema } from "effect";

import { readTrustBlocks } from "./codex-toml.ts";
import { codexTrustHash } from "./codex-trust.ts";
import type { Integration, IntegrationHome, IntegrationService } from "./integration.ts";
import { createIntegrationService, INTEGRATIONS } from "./service.ts";

interface Fixture extends AsyncDisposable {
  readonly home: IntegrationHome;
  readonly service: IntegrationService;
  configPath(id: IntegrationID): string;
  status(id: IntegrationID): Promise<IntegrationStatus>;
}

type HookSettings = (typeof SettingsSchema)["Type"];

type HookGroups = NonNullable<HookSettings["hooks"]>;

type HookGroup = HookGroups[string][number];

const AVAILABLE = "/opt/homebrew/bin/claude";

const processes: ProcessRunning = {
  run: () => Promise.reject(new Error("no subprocess in this test")),
  which: (executable: string) => Promise.resolve(executable === "claude" ? AVAILABLE : undefined),
};

const SettingsSchema = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  hooks: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          matcher: Schema.optionalKey(Schema.String),
          hooks: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              command: Schema.String,
              timeout: Schema.optionalKey(Schema.Number),
            }),
          ),
        }),
      ),
    ),
  ),
});

const decodeSettings = Schema.decodeUnknownSync(Schema.fromJsonString(SettingsSchema));

describe("overview", () => {
  test("names every harness in registry order and reports PATH availability", async () => {
    await using home = await fixture();

    const overview = await home.service.overview();

    expect(overview.integrations.map((report) => report.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "omp",
    ]);

    expect(overview.integrations.map((report) => report.isAvailable)).toEqual([
      true,
      false,
      false,
      false,
    ]);

    expect(overview.integrations.every((report) => report.reports.length === 3)).toBe(true);
    expect(overview.integrations.every((report) => report.status.kind === "absent")).toBe(true);
  });
});

describe("claude", () => {
  test("install writes one entry per reported event", async () => {
    await using home = await fixture();

    await home.service.install("claude");

    const settings = await readSettings(home.configPath("claude"));
    const hooks = groupsOf(settings);

    expect(Object.keys(hooks)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "StopFailure",
    ]);

    expect(commandOf(hooks, "UserPromptSubmit")).toContain("]7770;working");
    expect(commandOf(hooks, "PermissionRequest")).toContain("]7770;waiting;permission");
    expect(commandOf(hooks, "Stop")).toContain("]7770;finished;completed");
    expect(commandOf(hooks, "StopFailure")).toContain("]7770;finished;failed");
    expect(matcherOf(hooks, "PreToolUse")).toBe("AskUserQuestion");
    expect(matcherOf(hooks, "Stop")).toBeUndefined();
    expect(await home.status("claude")).toEqual({ kind: "installed" });
  });

  test("install keeps another tool's settings and hooks", async () => {
    await using home = await fixture();
    const path = home.configPath("claude");

    await seed(
      path,
      `${JSON.stringify(
        {
          model: "opus",
          hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool --stop" }] }] },
        },
        undefined,
        2,
      )}\n`,
    );

    await home.service.install("claude");

    const settings = await readSettings(path);
    const hooks = groupsOf(settings);

    expect(settings.model).toBe("opus");
    expect(hooks["Stop"]).toHaveLength(2);
    expect(commandAt(hooks, "Stop", 0)).toBe("other-tool --stop");
    expect(commandAt(hooks, "Stop", 1)).toContain("]7770;finished;completed");
  });

  test("installing twice writes identical bytes", async () => {
    await using home = await fixture();
    const path = home.configPath("claude");

    await home.service.install("claude");

    const first = await readFile(path, "utf8");

    await home.service.install("claude");

    expect(await readFile(path, "utf8")).toBe(first);
  });

  test("status walks absent, installed, outdated, absent while foreign settings survive", async () => {
    await using home = await fixture();
    const path = home.configPath("claude");

    await seed(path, `${JSON.stringify({ model: "opus" }, undefined, 2)}\n`);

    expect(await home.status("claude")).toEqual({ kind: "absent" });

    await home.service.install("claude");

    expect(await home.status("claude")).toEqual({ kind: "installed" });

    await writeFile(path, (await readFile(path, "utf8")).replace("]7770;working", "]7770;idle"));

    expect(await home.status("claude")).toEqual({ kind: "outdated" });

    await home.service.install("claude");

    expect(await home.status("claude")).toEqual({ kind: "installed" });

    await home.service.remove("claude");

    expect(await home.status("claude")).toEqual({ kind: "absent" });

    const settings = await readSettings(path);

    expect(settings.model).toBe("opus");
    expect(settings.hooks).toBeUndefined();
  });

  test("a settings file Janela cannot parse is reported, not overwritten", async () => {
    await using home = await fixture();
    const path = home.configPath("claude");

    await seed(path, "{ not json\n");

    expect(await home.status("claude")).toEqual({
      kind: "unreadable",
      reason: "settings.json is not a JSON object Janela can edit",
    });

    await expect(home.service.install("claude")).rejects.toThrow(path);
    expect(await readFile(path, "utf8")).toBe("{ not json\n");
  });
});

describe("codex", () => {
  test("install writes hooks.json plus a trust block Codex will accept", async () => {
    await using home = await fixture();
    const hooksPath = home.configPath("codex");

    await home.service.install("codex");

    const hooks = groupsOf(await readSettings(hooksPath));

    expect(Object.keys(hooks)).toEqual([
      "UserPromptSubmit",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
    ]);

    expect(timeoutOf(hooks, "Stop")).toBe(10);

    const blocks = readTrustBlocks(await readFile(codexConfig(home.home), "utf8"));

    expect(blocks.map((block) => block.key)).toEqual([
      `${hooksPath}:user_prompt_submit:0:0`,
      `${hooksPath}:permission_request:0:0`,
      `${hooksPath}:post_tool_use:0:0`,
      `${hooksPath}:stop:0:0`,
    ]);

    expect(blocks[3]?.hash).toBe(
      codexTrustHash({ label: "stop", command: commandOf(hooks, "Stop"), timeout: 10 }),
    );

    expect(await home.status("codex")).toEqual({ kind: "installed" });
  });

  test("trust keys name the canonical hooks path, not the symlink it was written through", async () => {
    await using directory = await temporaryDirectory("codex-canonical");
    const real = directory.join("real");
    const linked = directory.join("linked");

    await mkdir(real, { recursive: true });
    await symlink(real, linked);

    const home: IntegrationHome = {
      directory: linked,
      environment: { PATH: "/usr/bin:/bin", HOME: linked },
    };

    const service = createIntegrationService({ home, processes });

    await service.install("codex");

    const canonicalHome = await realpath(linked);
    const canonicalHooks = join(canonicalHome, ".codex", "hooks.json");
    const blocks = readTrustBlocks(await readFile(join(linked, ".codex", "config.toml"), "utf8"));

    expect(canonicalHome).not.toBe(linked);
    expect(blocks).toHaveLength(4);
    expect(blocks.every((block) => block.key.startsWith(`${canonicalHooks}:`))).toBe(true);
    expect(await statusOf(service, "codex")).toEqual({ kind: "installed" });
  });

  test("a foreign hook keeps index zero and its own trust block", async () => {
    await using home = await fixture();
    const hooksPath = home.configPath("codex");
    const configPath = codexConfig(home.home);

    await seed(
      hooksPath,
      `${JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "other", timeout: 5 }] }],
          },
        },
        undefined,
        2,
      )}\n`,
    );

    await seed(
      configPath,
      `model = "gpt-5"\n\n[hooks.state."${hooksPath}:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:foreign"\n`,
    );

    await home.service.install("codex");

    const blocks = readTrustBlocks(await readFile(configPath, "utf8"));
    const keys = blocks.map((block) => block.key);

    expect(commandAt(groupsOf(await readSettings(hooksPath)), "UserPromptSubmit", 0)).toBe("other");
    expect(keys).toContain(`${hooksPath}:user_prompt_submit:1:0`);
    expect(blocks.find((block) => block.key === `${hooksPath}:user_prompt_submit:0:0`)?.hash).toBe(
      "sha256:foreign",
    );

    expect(await readFile(configPath, "utf8")).toContain(`model = "gpt-5"`);
    expect(await home.status("codex")).toEqual({ kind: "installed" });
  });

  test("a trust hash Codex would reject reports outdated", async () => {
    await using home = await fixture();
    const configPath = codexConfig(home.home);

    await home.service.install("codex");

    const trusted = await readFile(configPath, "utf8");

    await writeFile(
      configPath,
      trusted.replace(/trusted_hash = "sha256:./, `trusted_hash = "sha256:0`),
    );

    expect(await home.status("codex")).toEqual({ kind: "outdated" });
  });

  test("a missing trust block reports outdated", async () => {
    await using home = await fixture();

    await home.service.install("codex");
    await writeFile(codexConfig(home.home), `model = "gpt-5"\n`);

    expect(await home.status("codex")).toEqual({ kind: "outdated" });
  });

  test("installing twice writes identical bytes to both files", async () => {
    await using home = await fixture();
    const hooksPath = home.configPath("codex");
    const configPath = codexConfig(home.home);

    await home.service.install("codex");

    const hooks = await readFile(hooksPath, "utf8");
    const config = await readFile(configPath, "utf8");

    await home.service.install("codex");

    expect(await readFile(hooksPath, "utf8")).toBe(hooks);
    expect(await readFile(configPath, "utf8")).toBe(config);
  });

  test("remove strips our hooks and our trust blocks and nothing else", async () => {
    await using home = await fixture();
    const hooksPath = home.configPath("codex");
    const configPath = codexConfig(home.home);

    await seed(
      hooksPath,
      `${JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } },
        undefined,
        2,
      )}\n`,
    );

    await seed(configPath, `model = "gpt-5"\n`);

    await home.service.install("codex");
    await home.service.remove("codex");

    expect(await home.status("codex")).toEqual({ kind: "absent" });
    expect(commandAt(groupsOf(await readSettings(hooksPath)), "Stop", 0)).toBe("other");
    expect(await readFile(configPath, "utf8")).toBe(`model = "gpt-5"\n`);
  });
});

describe.each([
  { id: "opencode", suffix: join("opencode", "plugins", "janela-activity.js") },
  { id: "omp", suffix: join("extensions", "janela-activity.ts") },
] as const)("$id", ({ id, suffix }) => {
  test("the file Janela owns is written, watched for edits, and taken away again", async () => {
    await using home = await fixture();
    const path = home.configPath(id);

    expect(path.endsWith(suffix)).toBe(true);
    expect(await home.status(id)).toEqual({ kind: "absent" });

    await home.service.install(id);

    const written = await readFile(path, "utf8");

    expect(written).toContain(String.raw`\u001b]7770;working\u0007`);
    expect(written).toContain("JANELA_TTY");
    expect(await home.status(id)).toEqual({ kind: "installed" });

    await writeFile(path, `${written}\n`);

    expect(await home.status(id)).toEqual({ kind: "outdated" });

    await home.service.install(id);

    expect(await home.status(id)).toEqual({ kind: "installed" });
    expect(await readFile(path, "utf8")).toBe(written);

    await home.service.remove(id);

    expect(await home.status(id)).toEqual({ kind: "absent" });
  });
});

async function fixture(): Promise<Fixture> {
  const directory = await temporaryDirectory("integrations");
  const home: IntegrationHome = {
    directory: directory.path,
    environment: { PATH: "/usr/bin:/bin", HOME: directory.path },
  };

  const service = createIntegrationService({ home, processes });

  return {
    home,
    service,
    configPath: (id: IntegrationID) => integrationOf(id).configPath(home),
    status: (id: IntegrationID) => statusOf(service, id),
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
}

function integrationOf(id: IntegrationID): Integration {
  const found = INTEGRATIONS.find((candidate) => candidate.id === id);

  if (found === undefined) throw new Error(`no integration registered for ${id}`);

  return found;
}

async function statusOf(
  service: IntegrationService,
  id: IntegrationID,
): Promise<IntegrationStatus> {
  const overview = await service.overview();
  const report = overview.integrations.find((entry) => entry.id === id);

  if (report === undefined) throw new Error(`no report for ${id}`);

  return report.status;
}

async function seed(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function readSettings(path: string): Promise<HookSettings> {
  return decodeSettings(await readFile(path, "utf8"));
}

function groupsOf(settings: HookSettings): HookGroups {
  return settings.hooks ?? {};
}

function groupAt(groups: HookGroups, event: string, index: number): HookGroup | undefined {
  return (groups[event] ?? [])[index];
}

function commandAt(groups: HookGroups, event: string, index: number): string | undefined {
  return groupAt(groups, event, index)?.hooks[0]?.command;
}

function commandOf(groups: HookGroups, event: string): string {
  const command = commandAt(groups, event, (groups[event] ?? []).length - 1);

  if (command === undefined) throw new Error(`no Janela command under ${event}`);

  return command;
}

function timeoutOf(groups: HookGroups, event: string): number | undefined {
  return groupAt(groups, event, 0)?.hooks[0]?.timeout;
}

function matcherOf(groups: HookGroups, event: string): string | undefined {
  return groupAt(groups, event, (groups[event] ?? []).length - 1)?.matcher;
}

function codexConfig(home: IntegrationHome): string {
  return join(home.directory, ".codex", "config.toml");
}
