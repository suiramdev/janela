import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import { agentActivityEscape } from "@janela/core";
import { temporaryDirectory } from "@janela/test-support";

import type { IntegrationHome } from "./integration.ts";
import { ompIntegration } from "./omp.ts";
import { opencodeIntegration } from "./opencode.ts";
import { TTY_VARIABLE } from "./report-command.ts";
import { integrationFiles } from "./service.ts";

interface OpenCodeStatus {
  readonly type: string;
}

interface OpenCodeProperties {
  readonly status: OpenCodeStatus;
}

interface OpenCodeEvent {
  readonly type: string;
  readonly properties?: OpenCodeProperties;
}

interface OpenCodeDelivery {
  readonly event: OpenCodeEvent;
}

interface OpenCodePlugin {
  readonly event: ((delivery: OpenCodeDelivery) => Promise<void>) | undefined;
}

interface OpenCodeModule {
  readonly JanelaActivity: (() => Promise<OpenCodePlugin>) | undefined;
}

interface PiEvent {
  readonly toolName?: string;
}

type PiHandler = (event: PiEvent) => void;

interface PiHandlers {
  [event: string]: PiHandler;
}

interface PiRegistration {
  readonly on: (event: string, handler: PiHandler) => void;
}

interface PiModule {
  readonly default: ((registration: PiRegistration) => void) | undefined;
}

const inherited = process.env[TTY_VARIABLE];

afterEach(() => {
  if (inherited === undefined) delete process.env[TTY_VARIABLE];
  else process.env[TTY_VARIABLE] = inherited;
});

describe("the OpenCode plugin", () => {
  test("loads as ESM and reports through the variable Janela exports", async () => {
    await using directory = await temporaryDirectory("opencode-plugin");
    const home = configuredHome(directory.path, "XDG_CONFIG_HOME");
    const target = directory.join("reported");

    await opencodeIntegration.install(integrationFiles(), home);
    await writeFile(target, "");
    process.env[TTY_VARIABLE] = target;

    const emit = await openCodeEmitter(opencodeIntegration.configPath(home));

    const reportOf = async (event: OpenCodeEvent): Promise<string> => {
      await writeFile(target, "");
      await emit(event);

      return readFile(target, "utf8");
    };

    expect(
      await reportOf({ type: "session.status", properties: { status: { type: "busy" } } }),
    ).toBe(agentActivityEscape({ kind: "working" }));
    expect(
      await reportOf({ type: "session.status", properties: { status: { type: "idle" } } }),
    ).toBe(agentActivityEscape({ kind: "finished", outcome: "completed" }));
    expect(await reportOf({ type: "permission.asked" })).toBe(
      agentActivityEscape({ kind: "waiting", need: "permission" }),
    );
    expect(await reportOf({ type: "question.asked" })).toBe(
      agentActivityEscape({ kind: "waiting", need: "input" }),
    );
    expect(await reportOf({ type: "question.replied" })).toBe(
      agentActivityEscape({ kind: "working" }),
    );
    expect(await reportOf({ type: "session.idle" })).toBe(
      agentActivityEscape({ kind: "finished", outcome: "completed" }),
    );
    expect(await reportOf({ type: "session.error" })).toBe(
      agentActivityEscape({ kind: "finished", outcome: "failed" }),
    );
    expect(await reportOf({ type: "session.updated" })).toBe("");
  });

  test("does nothing when Janela is not the terminal", async () => {
    await using directory = await temporaryDirectory("opencode-quiet");
    const home = configuredHome(directory.path, "XDG_CONFIG_HOME");

    await opencodeIntegration.install(integrationFiles(), home);

    const emit = await openCodeEmitter(opencodeIntegration.configPath(home));

    delete process.env[TTY_VARIABLE];

    await emit({ type: "session.idle" });
    await emit({ type: "session.status" });
    await emit({ type: "permission.asked" });
  });
});

describe("the Oh My Pi extension", () => {
  test("registers one handler per reported event and reports through the variable", async () => {
    await using directory = await temporaryDirectory("omp-extension");
    const home = configuredHome(directory.path, "PI_CODING_AGENT_DIR");
    const target = directory.join("reported");

    await ompIntegration.install(integrationFiles(), home);
    await writeFile(target, "");
    process.env[TTY_VARIABLE] = target;

    const handlers = await piHandlers(ompIntegration.configPath(home));

    expect(Object.keys(handlers)).toEqual([
      "agent_start",
      "agent_end",
      "tool_approval_requested",
      "tool_approval_resolved",
      "tool_execution_start",
      "tool_execution_end",
    ]);

    const reportOf = async (event: string, toolName: string | undefined): Promise<string> => {
      await writeFile(target, "");
      handlers[event]?.(toolName === undefined ? {} : { toolName });

      return readFile(target, "utf8");
    };

    expect(await reportOf("agent_start", undefined)).toBe(agentActivityEscape({ kind: "working" }));
    expect(await reportOf("agent_end", undefined)).toBe(
      agentActivityEscape({ kind: "finished", outcome: "completed" }),
    );
    expect(await reportOf("tool_approval_requested", undefined)).toBe(
      agentActivityEscape({ kind: "waiting", need: "permission" }),
    );
    expect(await reportOf("tool_approval_resolved", undefined)).toBe(
      agentActivityEscape({ kind: "working" }),
    );
    expect(await reportOf("tool_execution_start", "ask")).toBe(
      agentActivityEscape({ kind: "waiting", need: "input" }),
    );
    expect(await reportOf("tool_execution_end", "ask")).toBe(
      agentActivityEscape({ kind: "working" }),
    );
    expect(await reportOf("tool_execution_start", "bash")).toBe("");
    expect(await reportOf("tool_execution_end", "bash")).toBe("");
  });

  test("does nothing when Janela is not the terminal", async () => {
    await using directory = await temporaryDirectory("omp-quiet");
    const home = configuredHome(directory.path, "PI_CODING_AGENT_DIR");

    await ompIntegration.install(integrationFiles(), home);

    const handlers = await piHandlers(ompIntegration.configPath(home));

    delete process.env[TTY_VARIABLE];

    handlers["agent_start"]?.({});
    handlers["tool_approval_requested"]?.({});
    handlers["agent_end"]?.({});
  });
});

function configuredHome(directory: string, variable: string): IntegrationHome {
  return { directory, environment: { [variable]: directory } };
}

async function openCodeEmitter(path: string): Promise<(event: OpenCodeEvent) => Promise<void>> {
  const loaded: OpenCodeModule = await import(path);

  if (loaded.JanelaActivity === undefined) {
    throw new Error("the template exports no JanelaActivity");
  }

  const plugin = await loaded.JanelaActivity();
  const handle = plugin.event;

  if (handle === undefined) throw new Error("the plugin registers no event handler");

  return async (event: OpenCodeEvent) => {
    await handle({ event });
  };
}

async function piHandlers(path: string): Promise<PiHandlers> {
  const loaded: PiModule = await import(path);

  if (loaded.default === undefined) throw new Error("the template exports no default");

  const handlers: PiHandlers = {};

  loaded.default({
    on: (event: string, handler: PiHandler) => {
      handlers[event] = handler;
    },
  });

  return handlers;
}
