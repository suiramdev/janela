import { join } from "node:path";

import type { IntegrationStatus } from "@janela/core";

import type { Integration, IntegrationFiles, IntegrationHome } from "./integration.ts";
import { activityEscapeSource, TTY_VARIABLE } from "./report-command.ts";

const CONFIG_VARIABLE = "XDG_CONFIG_HOME";

const DEFAULT_DIRECTORY = ".config";

const PLUGIN_FILE = join("opencode", "plugins", "janela-activity.js");

const PLUGIN = `import { closeSync, openSync, writeSync } from "node:fs";

const ACTIVITY = {
${activityEscapeSource()}
};

const BY_EVENT = {
  "session.idle": ACTIVITY.finishedCompleted,
  "session.error": ACTIVITY.finishedFailed,
  "permission.asked": ACTIVITY.waitingPermission,
  "permission.updated": ACTIVITY.waitingPermission,
  "permission.replied": ACTIVITY.working,
  "question.asked": ACTIVITY.waitingInput,
  "question.replied": ACTIVITY.working,
  "question.rejected": ACTIVITY.working,
};

const BY_STATUS = {
  busy: ACTIVITY.working,
  idle: ACTIVITY.finishedCompleted,
};

function report(escape) {
  const tty = process.env.${TTY_VARIABLE};
  if (!tty || !escape) return;
  let handle;
  try {
    handle = openSync(tty, "w");
    writeSync(handle, escape);
  } catch {
    return;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function statusName(properties) {
  const status = properties?.status;
  if (typeof status === "string") return status;
  if (typeof status?.type === "string") return status.type;
  return "";
}

export const JanelaActivity = async () => ({
  event: async ({ event }) => {
    if (typeof event?.type !== "string") return;
    if (event.type === "session.status") {
      report(BY_STATUS[statusName(event.properties)]);
      return;
    }
    report(BY_EVENT[event.type]);
  },
});
`;

export const opencodeIntegration: Integration = {
  id: "opencode",
  name: "OpenCode",
  executable: "opencode",
  reports: [
    "Working while a session is busy",
    "Waiting when it asks permission or a question",
    "Finished when the session goes idle or fails",
  ],

  configPath(home: IntegrationHome): string {
    return pluginPath(home);
  },

  async status(files: IntegrationFiles, home: IntegrationHome): Promise<IntegrationStatus> {
    const text = await files.read(pluginPath(home));

    if (text === undefined) return { kind: "absent" };

    return text === PLUGIN ? { kind: "installed" } : { kind: "outdated" };
  },

  async install(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    await files.write(pluginPath(home), PLUGIN);
  },

  async remove(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    await files.remove(pluginPath(home));
  },
};

function pluginPath(home: IntegrationHome): string {
  const configured = home.environment[CONFIG_VARIABLE];

  return join(
    configured === undefined || configured.length === 0
      ? join(home.directory, DEFAULT_DIRECTORY)
      : configured,
    PLUGIN_FILE,
  );
}
