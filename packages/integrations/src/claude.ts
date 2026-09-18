import { join } from "node:path";

import type { AgentActivity, IntegrationStatus } from "@janela/core";

import { IntegrationConfigUnreadable } from "./errors.ts";
import {
  hookStatus,
  parseHookDocument,
  serializeHookDocument,
  withJanelaHooks,
  withoutJanelaHooks,
  type HookDocument,
  type HookPlan,
} from "./hook-document.ts";
import type { Integration, IntegrationFiles, IntegrationHome } from "./integration.ts";
import { ACTIVITIES, hookCommand } from "./report-command.ts";

interface ClaudeEvent {
  readonly event: string;
  readonly matcher?: string;
  readonly activity: AgentActivity;
}

const CONFIG_VARIABLE = "CLAUDE_CONFIG_DIR";

const DEFAULT_DIRECTORY = ".claude";

const SETTINGS_FILE = "settings.json";

const CLAUDE_EVENTS: readonly ClaudeEvent[] = [
  { event: "UserPromptSubmit", activity: ACTIVITIES.working },
  { event: "PreToolUse", matcher: "AskUserQuestion", activity: ACTIVITIES.waitingInput },
  { event: "PermissionRequest", activity: ACTIVITIES.waitingPermission },
  { event: "PostToolUse", activity: ACTIVITIES.working },
  { event: "Stop", activity: ACTIVITIES.finishedCompleted },
  { event: "StopFailure", activity: ACTIVITIES.finishedFailed },
];

const CLAUDE_PLANS: readonly HookPlan[] = CLAUDE_EVENTS.map((spec) => {
  const hooks = [{ type: "command", command: hookCommand(spec.activity) }] as const;

  return {
    event: spec.event,
    entry: spec.matcher === undefined ? { hooks } : { matcher: spec.matcher, hooks },
  };
});

export const claudeIntegration: Integration = {
  id: "claude",
  name: "Claude Code",
  executable: "claude",
  reports: [
    "Working when you submit a prompt or a tool finishes",
    "Waiting when it asks permission or a question",
    "Finished when the turn ends",
  ],

  configPath(home: IntegrationHome): string {
    return settingsPath(home);
  },

  async status(files: IntegrationFiles, home: IntegrationHome): Promise<IntegrationStatus> {
    const text = await files.read(settingsPath(home));

    if (text === undefined) return { kind: "absent" };

    const document = parseHookDocument(text);

    return document === undefined
      ? { kind: "unreadable", reason: `${SETTINGS_FILE} is not a JSON object Janela can edit` }
      : hookStatus(document, CLAUDE_PLANS);
  },

  async install(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    const path = settingsPath(home);
    const document = await load(files, path);

    await files.write(path, serializeHookDocument(withJanelaHooks(document, CLAUDE_PLANS).root));
  },

  async remove(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    const path = settingsPath(home);
    const text = await files.read(path);

    if (text === undefined) return;

    const document = await load(files, path);
    const root = withoutJanelaHooks(document);

    if (Object.keys(root).length === 0) await files.remove(path);
    else await files.write(path, serializeHookDocument(root));
  },
};

function settingsPath(home: IntegrationHome): string {
  const configured = home.environment[CONFIG_VARIABLE];

  return join(
    configured === undefined || configured.length === 0
      ? join(home.directory, DEFAULT_DIRECTORY)
      : configured,
    SETTINGS_FILE,
  );
}

async function load(files: IntegrationFiles, path: string): Promise<HookDocument> {
  const text = await files.read(path);

  if (text === undefined) return { root: {}, groups: {} };

  const document = parseHookDocument(text);

  if (document === undefined) {
    throw new IntegrationConfigUnreadable({ integration: "claude", path });
  }

  return document;
}
