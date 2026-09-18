import { join } from "node:path";

import type { AgentActivity, IntegrationStatus } from "@janela/core";

import { readTrustBlocks, rewriteTrustBlocks, type TrustBlock } from "./codex-toml.ts";
import { codexTrustHash, trustKey, type CodexTrustSubject } from "./codex-trust.ts";
import { IntegrationConfigUnreadable } from "./errors.ts";
import {
  hookStatus,
  janelaEntry,
  parseHookDocument,
  serializeHookDocument,
  withJanelaHooks,
  withoutJanelaHooks,
  type HookDocument,
  type HookPlan,
} from "./hook-document.ts";
import type { Integration, IntegrationFiles, IntegrationHome } from "./integration.ts";
import { ACTIVITIES, hookCommand } from "./report-command.ts";

interface CodexEvent {
  readonly event: string;
  readonly label: string;
  readonly activity: AgentActivity;
}

const CONFIG_VARIABLE = "CODEX_HOME";

const DEFAULT_DIRECTORY = ".codex";

const HOOKS_FILE = "hooks.json";

const CONFIG_FILE = "config.toml";

export const CODEX_HANDLER_TIMEOUT = 10;

const CODEX_EVENTS: readonly CodexEvent[] = [
  { event: "UserPromptSubmit", label: "user_prompt_submit", activity: ACTIVITIES.working },
  {
    event: "PermissionRequest",
    label: "permission_request",
    activity: ACTIVITIES.waitingPermission,
  },
  { event: "PostToolUse", label: "post_tool_use", activity: ACTIVITIES.working },
  { event: "Stop", label: "stop", activity: ACTIVITIES.finishedCompleted },
];

const CODEX_PLANS: readonly HookPlan[] = CODEX_EVENTS.map((spec) => ({
  event: spec.event,
  entry: {
    hooks: [
      {
        type: "command",
        command: hookCommand(spec.activity),
        timeout: CODEX_HANDLER_TIMEOUT,
      },
    ],
  },
}));

export const codexIntegration: Integration = {
  id: "codex",
  name: "Codex",
  executable: "codex",
  reports: [
    "Working when you submit a prompt or a tool finishes",
    "Waiting when it asks permission to act",
    "Finished when the turn ends",
  ],

  configPath(home: IntegrationHome): string {
    return hooksPath(home);
  },

  async status(files: IntegrationFiles, home: IntegrationHome): Promise<IntegrationStatus> {
    const hooks = hooksPath(home);
    const text = await files.read(hooks);

    if (text === undefined) return { kind: "absent" };

    const document = parseHookDocument(text);

    if (document === undefined) {
      return { kind: "unreadable", reason: `${HOOKS_FILE} is not a JSON object Janela can edit` };
    }

    const layout = hookStatus(document, CODEX_PLANS);

    if (layout.kind !== "installed") return layout;

    const trusted = readTrustBlocks((await files.read(configPath(home))) ?? "");
    const expected = janelaTrustBlocks(await files.canonical(hooks), document);
    const isTrusted = expected.every((block) =>
      trusted.some((found) => found.key === block.key && found.hash === block.hash),
    );

    return isTrusted ? { kind: "installed" } : { kind: "outdated" };
  },

  async install(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    const hooks = hooksPath(home);
    const current = await load(files, hooks);
    const next = withJanelaHooks(current, CODEX_PLANS);

    await files.write(hooks, serializeHookDocument(next.root));

    const canonical = await files.canonical(hooks);
    const added = janelaTrustBlocks(canonical, next);
    const dropped = new Set([
      ...janelaTrustBlocks(canonical, current).map((block) => block.key),
      ...added.map((block) => block.key),
    ]);

    await writeTrust(files, configPath(home), dropped, added);
  },

  async remove(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    const hooks = hooksPath(home);

    if ((await files.read(hooks)) === undefined) return;

    const current = await load(files, hooks);
    const canonical = await files.canonical(hooks);
    const dropped = new Set(janelaTrustBlocks(canonical, current).map((block) => block.key));
    const root = withoutJanelaHooks(current);

    if (Object.keys(root).length === 0) await files.remove(hooks);
    else await files.write(hooks, serializeHookDocument(root));

    await writeTrust(files, configPath(home), dropped, []);
  },
};

export function janelaTrustBlocks(hooks: string, document: HookDocument): readonly TrustBlock[] {
  const blocks: TrustBlock[] = [];

  for (const spec of CODEX_EVENTS) {
    const entries = document.groups[spec.event] ?? [];

    entries.forEach((value, groupIndex) => {
      const entry = janelaEntry(value);

      if (entry === undefined) return;

      entry.hooks.forEach((handler, handlerIndex) => {
        const subject: CodexTrustSubject =
          entry.matcher === undefined
            ? { label: spec.label, command: handler.command, timeout: handler.timeout ?? 0 }
            : {
                label: spec.label,
                command: handler.command,
                timeout: handler.timeout ?? 0,
                matcher: entry.matcher,
              };

        blocks.push({
          key: trustKey(hooks, spec.label, groupIndex, handlerIndex),
          hash: codexTrustHash(subject),
        });
      });
    });
  }

  return blocks;
}

function codexDirectory(home: IntegrationHome): string {
  const configured = home.environment[CONFIG_VARIABLE];

  return configured === undefined || configured.length === 0
    ? join(home.directory, DEFAULT_DIRECTORY)
    : configured;
}

function hooksPath(home: IntegrationHome): string {
  return join(codexDirectory(home), HOOKS_FILE);
}

function configPath(home: IntegrationHome): string {
  return join(codexDirectory(home), CONFIG_FILE);
}

async function load(files: IntegrationFiles, path: string): Promise<HookDocument> {
  const text = await files.read(path);

  if (text === undefined) return { root: {}, groups: {} };

  const document = parseHookDocument(text);

  if (document === undefined) {
    throw new IntegrationConfigUnreadable({ integration: "codex", path });
  }

  return document;
}

async function writeTrust(
  files: IntegrationFiles,
  path: string,
  dropped: ReadonlySet<string>,
  added: readonly TrustBlock[],
): Promise<void> {
  const text = rewriteTrustBlocks((await files.read(path)) ?? "", dropped, added);

  if (text.length === 0) await files.remove(path);
  else await files.write(path, text);
}
