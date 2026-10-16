import type { AutomationEvent, Project } from "@janela/core";
import { AUTOMATION_EVENTS, supportsWorktrees } from "@janela/core";

import { COMMANDS } from "../../../shared/config/index.ts";
import { fuzzyScore } from "../../../shared/lib/fuzzy-match/index.ts";
import type { SettingsRoute, SettingsTabID } from "../../../shared/model/index.ts";
import { AUTOMATION_EVENT_TITLE } from "./automation-scripts.ts";

export type SettingsSectionID =
  | "appearanceTheme"
  | "appearanceFont"
  | "notificationsEvents"
  | "shortcuts"
  | "integrationsHooks"
  | "integrationsNaming"
  | "closingConfirmation"
  | "notificationPermission"
  | "daemon"
  | "projectWorktrees"
  | "projectAutomation"
  | "automationWorktreeCreated"
  | "automationSessionStart"
  | "automationSessionTeardown";

export interface SettingsSection {
  readonly id: SettingsSectionID;

  readonly title: string;

  readonly fields: readonly string[];

  readonly keywords: readonly string[];
}

export interface SettingsTabInfo {
  readonly id: SettingsTabID;
  readonly title: string;
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

export const APPEARANCE_THEME_SECTION: SettingsSection = {
  id: "appearanceTheme",
  title: "Window",
  fields: ["Theme"],
  keywords: ["appearance", "theme", "light", "dark", "system", "mode", "colours", "scheme"],
};

export const APPEARANCE_FONT_SECTION: SettingsSection = {
  id: "appearanceFont",
  title: "Terminal",
  fields: ["Font family", "Font size"],
  keywords: ["appearance", "typeface", "monospace", "size", "zoom", "font", "nerd font"],
};

export const NOTIFICATIONS_EVENTS_SECTION: SettingsSection = {
  id: "notificationsEvents",
  title: "Notify me when",
  fields: [
    "A terminal rings the bell",
    "An agent is waiting for you",
    "An agent finishes",
    "An agent stops with an error",
  ],
  keywords: [
    "bell",
    "alert",
    "badge",
    "banner",
    "notification centre",
    "attention",
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
    "error",
    "failed",
    "sound",
    "audio",
    "chime",
    "ping",
    "silent",
    "mute",
    "custom",
    "aiff",
    "wav",
    "volume",
  ],
};

export const SHORTCUTS_SECTION: SettingsSection = {
  id: "shortcuts",
  title: "Shortcuts",
  fields: COMMANDS.map((command) => command.title),
  keywords: ["shortcut", "keyboard", "chord", "key", "binding", "rebind", "hotkey", "menu"],
};

export const INTEGRATIONS_HOOKS_SECTION: SettingsSection = {
  id: "integrationsHooks",
  title: "Agents",
  fields: [],
  keywords: [
    "integration",
    "hook",
    "hooks",
    "extension",
    "plugin",
    "install",
    "activity",
    "reporting",
    "status",
    "spinner",
    "claude",
    "claude code",
    "codex",
    "opencode",
    "omp",
    "oh my pi",
    "settings.json",
    "hooks.json",
    "config.toml",
  ],
};

export const INTEGRATIONS_NAMING_SECTION: SettingsSection = {
  id: "integrationsNaming",
  title: "Session naming",
  fields: [],
  keywords: [
    "name",
    "rename",
    "title",
    "automatic",
    "auto",
    "summary",
    "summarise",
    "summarize",
    "prompt",
    "ai",
    "llm",
    "model",
    "provider",
    "effort",
    "reasoning",
    "thinking",
    "haiku",
    "claude",
    "codex",
    "omp",
    "oh my pi",
  ],
};

export const CLOSING_CONFIRMATION_SECTION: SettingsSection = {
  id: "closingConfirmation",
  title: "Confirmations",
  fields: ["Ask before closing a running terminal"],
  keywords: ["confirmation", "confirm", "ask again", "prompt", "warning", "dialog", "close"],
};

export const NOTIFICATION_PERMISSION_SECTION: SettingsSection = {
  id: "notificationPermission",
  title: "macOS",
  fields: ["Notifications"],
  keywords: [
    "permission",
    "allow",
    "authorise",
    "authorize",
    "declined",
    "system settings",
    "notification centre",
  ],
};

export const DAEMON_SECTION: SettingsSection = {
  id: "daemon",
  title: "Daemon",
  fields: ["Running now", "Shut down"],
  keywords: [
    "janelad",
    "background",
    "service",
    "status",
    "sessions",
    "live",
    "terminals",
    "stop",
    "quit",
    "restart",
    "unregister",
    "login items",
    "survive",
    "uninstall",
  ],
};

export const PROJECT_WORKTREES_SECTION: SettingsSection = {
  id: "projectWorktrees",
  title: "Worktrees",
  fields: ["Location"],
  keywords: ["worktree", "branch", "directory", "root", "sibling", "path", "git"],
};

export const PROJECT_AUTOMATION_SECTION: SettingsSection = {
  id: "projectAutomation",
  title: "Automation",
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
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
  sessionStart: {
    id: "automationSessionStart",
    title: AUTOMATION_EVENT_TITLE.sessionStart,
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
  sessionTeardown: {
    id: "automationSessionTeardown",
    title: AUTOMATION_EVENT_TITLE.sessionTeardown,
    fields: [],
    keywords: AUTOMATION_KEYWORDS,
  },
} satisfies Record<AutomationEvent, SettingsSection>;

export const SETTINGS_TAB_INFO: readonly SettingsTabInfo[] = [
  {
    id: "appearance",
    title: "Appearance",
    sections: [APPEARANCE_THEME_SECTION, APPEARANCE_FONT_SECTION],
  },
  {
    id: "notifications",
    title: "Notifications",
    sections: [NOTIFICATIONS_EVENTS_SECTION],
  },
  {
    id: "shortcuts",
    title: "Shortcuts",
    sections: [SHORTCUTS_SECTION],
  },
  {
    id: "integrations",
    title: "Integrations",
    sections: [INTEGRATIONS_HOOKS_SECTION, INTEGRATIONS_NAMING_SECTION],
  },
  {
    id: "permissions",
    title: "Permissions",
    sections: [CLOSING_CONFIRMATION_SECTION, NOTIFICATION_PERMISSION_SECTION, DAEMON_SECTION],
  },
];

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
