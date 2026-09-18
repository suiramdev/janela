import type { AutomationEvent, Project } from "@janela/core";
import { AUTOMATION_EVENTS, supportsWorktrees } from "@janela/core";

import { COMMANDS } from "../../../shared/config/index.ts";
import { fuzzyScore } from "../../../shared/lib/fuzzy-match/index.ts";
import type { SettingsRoute, SettingsTabID } from "../../../shared/model/index.ts";
import { AUTOMATION_EVENT_HINT, AUTOMATION_EVENT_TITLE } from "./automation-scripts.ts";

export type SettingsSectionID =
  | "appearanceFont"
  | "notificationsBell"
  | "notificationsAgents"
  | "shortcuts"
  | "integrationsHooks"
  | "closingConfirmation"
  | "notificationPermission"
  | "daemon"
  | "daemonState"
  | "daemonStop"
  | "projectWorktrees"
  | "projectAutomation"
  | "automationWorktreeCreated"
  | "automationSessionStart"
  | "automationSessionTeardown";

export interface SettingsSection {
  readonly id: SettingsSectionID;

  readonly title: string;

  readonly hint?: string;

  readonly fields: readonly string[];

  readonly keywords: readonly string[];
}

export interface SettingsTabInfo {
  readonly id: SettingsTabID;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly SettingsSection[];
}

export interface SettingsMatch {
  readonly route: SettingsRoute;
  readonly section: SettingsSectionID;
  readonly detail: string;
}

interface SearchEntry {
  readonly route: SettingsRoute;
  readonly paneTitle: string;
  readonly section: SettingsSection;
}

interface ScoredMatch {
  readonly match: SettingsMatch;
  readonly score: number;
  readonly order: number;
}

export const APPEARANCE_FONT_SECTION: SettingsSection = {
  id: "appearanceFont",
  title: "Terminal font",
  fields: ["Font family", "Font size"],
  keywords: ["appearance", "typeface", "monospace", "size", "zoom", "theme", "colours"],
};

export const CLOSING_CONFIRMATION_SECTION: SettingsSection = {
  id: "closingConfirmation",
  title: "Closing a terminal",
  hint: "Closing a pane or a tab ends the programs in it, so the question is asked while there is still something to lose.",
  fields: ["Ask before closing a running terminal"],
  keywords: ["confirmation", "confirm", "ask again", "prompt", "warning", "dialog"],
};

export const NOTIFICATION_PERMISSION_SECTION: SettingsSection = {
  id: "notificationPermission",
  title: "Notification Centre",
  fields: [],
  keywords: ["permission", "allow", "authorise", "authorize", "declined", "system settings"],
};

export const SHORTCUTS_SECTION: SettingsSection = {
  id: "shortcuts",
  title: "Keyboard shortcuts",
  hint: "Every shortcut is ⌘ and a key, with ⇧ or ⌥ if you like. Ctrl is never one: it belongs to the program running in the terminal. The menu bar and the command palette follow whatever you set here.",
  fields: COMMANDS.map((command) => command.title),
  keywords: ["shortcut", "keyboard", "chord", "key", "binding", "rebind", "hotkey", "menu"],
};

export const NOTIFICATIONS_BELL_SECTION: SettingsSection = {
  id: "notificationsBell",
  title: "Bell",
  fields: ["Notify when a terminal rings the bell"],
  keywords: ["bell", "alert", "badge", "banner", "notification centre", "sound", "attention"],
};

export const NOTIFICATIONS_AGENTS_SECTION: SettingsSection = {
  id: "notificationsAgents",
  title: "Agents",
  hint: "An agent whose integration is installed tells Janela when it finishes a turn and when it is waiting on you. Both are shown in the sidebar whatever you choose here; this is only about interrupting you.",
  fields: ["Notify when an agent finishes", "Notify when an agent is waiting for you"],
  keywords: [
    "agent",
    "claude",
    "codex",
    "opencode",
    "omp",
    "finished",
    "done",
    "waiting",
    "permission",
    "question",
    "turn",
    "notification",
  ],
};

export const INTEGRATIONS_HOOKS_SECTION: SettingsSection = {
  id: "integrationsHooks",
  title: "Activity reporting",
  hint: "Each agent has its own hook or extension mechanism. Installing one adds a short entry to that agent's configuration which tells the terminal when the agent is working, waiting or finished. Janela reads nothing else — not the transcript, not the output.",
  fields: [],
  keywords: [
    "hook",
    "hooks",
    "extension",
    "plugin",
    "install",
    "activity",
    "status",
    "spinner",
    "claude",
    "codex",
    "opencode",
    "omp",
    "oh my pi",
    "settings.json",
    "hooks.json",
    "config.toml",
  ],
};

export const DAEMON_SECTION: SettingsSection = {
  id: "daemon",
  title: "Daemon",
  hint: "janelad runs your terminals, which is why they survive closing the window. It exits on its own when nothing is live.",
  fields: [],
  keywords: ["janelad", "background", "service"],
};

export const DAEMON_STATE_SECTION: SettingsSection = {
  id: "daemonState",
  title: "Running now",
  fields: [],
  keywords: ["janelad", "status", "sessions", "live", "terminals", "background"],
};

export const DAEMON_STOP_SECTION: SettingsSection = {
  id: "daemonStop",
  title: "Stopping it",
  hint: "Both of these end every live terminal, and neither acts on its first press.",
  fields: [],
  keywords: [
    "stop",
    "quit",
    "restart",
    "unregister",
    "login items",
    "background service",
    "survive",
    "uninstall",
  ],
};

export const PROJECT_WORKTREES_SECTION: SettingsSection = {
  id: "projectWorktrees",
  title: "Worktrees",
  hint: "Where sessions cut from a branch are created.",
  fields: ["Use a directory I choose"],
  keywords: ["worktree", "branch", "directory", "root", "sibling", "path", "git"],
};

export const PROJECT_AUTOMATION_SECTION: SettingsSection = {
  id: "projectAutomation",
  title: "Automation",
  hint: "A shell script for each moment in a session's life, run by your login shell in a real terminal you can watch and interrupt. Scripts are stored here and never read from the repository.",
  fields: [],
  keywords: [
    "automation",
    "script",
    "shell",
    "hook",
    "lifecycle",
    "run",
    "setup",
    "install",
    "bootstrap",
    "teardown",
    "environment",
    "variable",
  ],
};

const AUTOMATION_KEYWORDS: readonly string[] = ["automation", "script", "shell", "timeout"];

export const AUTOMATION_SECTION = {
  worktreeCreated: {
    id: "automationWorktreeCreated",
    title: AUTOMATION_EVENT_TITLE.worktreeCreated,
    hint: AUTOMATION_EVENT_HINT.worktreeCreated,
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
  sessionStart: {
    id: "automationSessionStart",
    title: AUTOMATION_EVENT_TITLE.sessionStart,
    hint: AUTOMATION_EVENT_HINT.sessionStart,
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
  sessionTeardown: {
    id: "automationSessionTeardown",
    title: AUTOMATION_EVENT_TITLE.sessionTeardown,
    hint: AUTOMATION_EVENT_HINT.sessionTeardown,
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
} satisfies Record<AutomationEvent, SettingsSection>;

export const SETTINGS_TAB_INFO: readonly SettingsTabInfo[] = [
  {
    id: "appearance",
    title: "Appearance",
    description:
      "How a terminal reads. Light, dark and Increase contrast are macOS settings, and Janela follows them rather than keeping its own.",
    sections: [APPEARANCE_FONT_SECTION],
  },
  {
    id: "notifications",
    title: "Notifications",
    description:
      "When Janela may interrupt you. It never notifies for the terminal you are looking at, and never while its window is frontmost and that session is selected.",
    sections: [NOTIFICATIONS_BELL_SECTION, NOTIFICATIONS_AGENTS_SECTION],
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    description:
      "The keys that reach Janela rather than the terminal. Change any of them; a chord another command already answers to is refused by name.",
    sections: [SHORTCUTS_SECTION],
  },
  {
    id: "integrations",
    title: "Integrations",
    description:
      "The hooks the agents you run can use to tell Janela what they are doing. Janela listens; it does not wrap, parse or manage what they do.",
    sections: [INTEGRATIONS_HOOKS_SECTION],
  },
  {
    id: "permissions",
    title: "Permissions",
    description:
      "What Janela asks before it acts, what macOS asks on its behalf, and the daemon that outlives the window.",
    sections: [
      CLOSING_CONFIRMATION_SECTION,
      NOTIFICATION_PERMISSION_SECTION,
      DAEMON_SECTION,
      DAEMON_STATE_SECTION,
      DAEMON_STOP_SECTION,
    ],
  },
];

export const PROJECT_PANE_DESCRIPTION =
  "Settings for one project. Every session it opens starts under these.";

export function projectSections(project: Project): readonly SettingsSection[] {
  return [
    ...(supportsWorktrees(project) ? [PROJECT_WORKTREES_SECTION] : []),
    PROJECT_AUTOMATION_SECTION,
    ...AUTOMATION_EVENTS.map((event) => AUTOMATION_SECTION[event]),
  ];
}

export function tabInfo(tab: SettingsTabID): SettingsTabInfo | undefined {
  return SETTINGS_TAB_INFO.find((info) => info.id === tab);
}

export function routeKey(route: SettingsRoute): string {
  return route.kind === "tab" ? route.tab : `project-${route.projectID}`;
}

export function sectionElementID(section: SettingsSectionID): string {
  return `janela-settings-section-${section}`;
}

function searchEntries(projects: readonly Project[]): readonly SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const info of SETTINGS_TAB_INFO) {
    for (const section of info.sections) {
      entries.push({ route: { kind: "tab", tab: info.id }, paneTitle: info.title, section });
    }
  }

  for (const project of projects) {
    for (const section of projectSections(project)) {
      entries.push({
        route: { kind: "project", projectID: project.id },
        paneTitle: project.name,
        section,
      });
    }
  }

  return entries;
}

function bestMatch(query: string, entry: SearchEntry, order: number): ScoredMatch | undefined {
  const { section } = entry;

  let score = fuzzyScore(query, section.title);
  let detail = section.title;

  for (const field of section.fields) {
    const scored = fuzzyScore(query, field);

    if (scored !== undefined && (score === undefined || scored > score)) {
      score = scored;
      detail = field;
    }
  }

  for (const text of [entry.paneTitle, ...section.keywords]) {
    const scored = fuzzyScore(query, text);

    if (scored !== undefined && (score === undefined || scored > score)) score = scored;
  }

  if (score === undefined) return undefined;

  return { match: { route: entry.route, section: section.id, detail }, score, order };
}

export function settingsMatches(
  query: string,
  projects: readonly Project[],
): readonly SettingsMatch[] {
  const trimmed = query.trim();

  if (trimmed.length === 0) return [];

  const scored: ScoredMatch[] = [];

  for (const [order, entry] of searchEntries(projects).entries()) {
    const match = bestMatch(trimmed, entry, order);

    if (match !== undefined) scored.push(match);
  }

  scored.sort((left, right) =>
    left.score === right.score ? left.order - right.order : right.score - left.score,
  );

  const seen = new Set<string>();
  const matches: SettingsMatch[] = [];

  for (const entry of scored) {
    const key = routeKey(entry.match.route);

    if (seen.has(key)) continue;

    seen.add(key);
    matches.push(entry.match);
  }

  return matches;
}
