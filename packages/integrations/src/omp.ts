import { join } from "node:path";

import type { IntegrationStatus } from "@janela/core";

import type { Integration, IntegrationFiles, IntegrationHome } from "./integration.ts";
import { activityEscapeSource, TTY_VARIABLE } from "./report-command.ts";

const CONFIG_VARIABLE = "PI_CODING_AGENT_DIR";

const DEFAULT_DIRECTORY = join(".omp", "agent");

const EXTENSION_FILE = join("extensions", "janela-activity.ts");

const EXTENSION = `import { closeSync, openSync, writeSync } from "node:fs";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const ACTIVITY = {
${activityEscapeSource()}
};

const ASK_TOOL = "ask";

function report(escape: string): void {
  const tty = process.env.${TTY_VARIABLE};
  if (!tty) return;
  let handle: number | undefined;
  try {
    handle = openSync(tty, "w");
    writeSync(handle, escape);
  } catch {
    return;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("agent_start", () => report(ACTIVITY.working));
  pi.on("agent_end", () => report(ACTIVITY.finishedCompleted));
  pi.on("tool_approval_requested", () => report(ACTIVITY.waitingPermission));
  pi.on("tool_approval_resolved", () => report(ACTIVITY.working));
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === ASK_TOOL) report(ACTIVITY.waitingInput);
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === ASK_TOOL) report(ACTIVITY.working);
  });
}
`;

export const ompIntegration: Integration = {
  id: "omp",
  name: "Oh My Pi",
  executable: "omp",
  reports: [
    "Working when the agent starts or an approval resolves",
    "Waiting when it asks permission or a question",
    "Finished when the agent stops",
  ],

  configPath(home: IntegrationHome): string {
    return extensionPath(home);
  },

  async status(files: IntegrationFiles, home: IntegrationHome): Promise<IntegrationStatus> {
    const text = await files.read(extensionPath(home));

    if (text === undefined) return { kind: "absent" };

    return text === EXTENSION ? { kind: "installed" } : { kind: "outdated" };
  },

  async install(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    await files.write(extensionPath(home), EXTENSION);
  },

  async remove(files: IntegrationFiles, home: IntegrationHome): Promise<void> {
    await files.remove(extensionPath(home));
  },
};

function extensionPath(home: IntegrationHome): string {
  const configured = home.environment[CONFIG_VARIABLE];

  return join(
    configured === undefined || configured.length === 0
      ? join(home.directory, DEFAULT_DIRECTORY)
      : configured,
    EXTENSION_FILE,
  );
}
