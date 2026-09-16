import type { AutomationEvent, Project } from "@janela/core";
import { AUTOMATION_EVENTS, supportsWorktrees } from "@janela/core";

import { fuzzyScore } from "../../../shared/lib/fuzzy-match/index.ts";
import type { SettingsRoute, SettingsTabID } from "../../../shared/model/index.ts";
import { AUTOMATION_EVENT_HINT, AUTOMATION_EVENT_TITLE } from "./automation-commands.ts";

export type SettingsSectionID =
  | "terminalFont"
  | "terminalClosing"
  | "profilesDefault"
  | "profilesList"
  | "notificationsBell"
  | "daemonState"
  | "daemonStop"
  | "projectSessions"
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

export const TERMINAL_FONT_SECTION: SettingsSection = {
  id: "terminalFont",
  title: "Font",
  fields: ["Font family", "Font size"],
  keywords: ["appearance", "typeface", "monospace", "size", "zoom", "theme", "colours"],
};

export const TERMINAL_CLOSING_SECTION: SettingsSection = {
  id: "terminalClosing",
  title: "Closing a terminal",
  hint: "Closing a pane or a tab ends the programs in it, so the question is asked while there is still something to lose.",
  fields: ["Ask before closing a running terminal"],
  keywords: ["confirmation", "confirm", "ask again", "prompt", "warning", "dialog"],
};

export const PROFILES_DEFAULT_SECTION: SettingsSection = {
  id: "profilesDefault",
  title: "New terminals",
  fields: ["Default launch profile"],
  keywords: ["default", "shell", "login shell", "zsh", "bash", "fallback"],
};

export const PROFILES_LIST_SECTION: SettingsSection = {
  id: "profilesList",
  title: "Profiles",
  fields: [],
  keywords: [
    "agent",
    "command",
    "argument",
    "argv",
    "environment",
    "variable",
    "icon",
    "duplicate",
    "delete",
    "claude",
    "codex",
  ],
};

export const NOTIFICATIONS_BELL_SECTION: SettingsSection = {
  id: "notificationsBell",
  title: "Notification Centre",
  fields: ["Notify when a terminal rings the bell"],
  keywords: ["bell", "alert", "badge", "banner", "permission", "sound", "attention"],
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

export const PROJECT_SESSIONS_SECTION: SettingsSection = {
  id: "projectSessions",
  title: "Sessions",
  hint: "What this project's sessions start in, and what Janela may read about them.",
  fields: ["Default launch profile", "Read pull request and check state"],
  keywords: ["profile", "forge", "github", "gitlab", "gh", "glab", "pull request", "checks"],
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
  hint: "Commands Janela runs for you, each in a real terminal in the session you can watch and interrupt. They are stored here and never read from the repository.",
  fields: [],
  keywords: ["automation", "command", "run", "setup", "install", "bootstrap", "teardown"],
};

const AUTOMATION_KEYWORDS: readonly string[] = ["automation", "command", "timeout", "enabled"];

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
    id: "terminal",
    title: "Terminal",
    description: "How a terminal reads, and what it asks before you end one.",
    sections: [TERMINAL_FONT_SECTION, TERMINAL_CLOSING_SECTION],
  },
  {
    id: "profiles",
    title: "Launch profiles",
    description:
      "What Janela starts in a new terminal. A profile is a command, not an integration: Janela does not wrap, parse or manage what it launches.",
    sections: [PROFILES_DEFAULT_SECTION, PROFILES_LIST_SECTION],
  },
  {
    id: "notifications",
    title: "Notifications",
    description:
      "When Janela may interrupt you. It never notifies for the terminal you are looking at, and never while its window is frontmost and that session is selected.",
    sections: [NOTIFICATIONS_BELL_SECTION],
  },
  {
    id: "daemon",
    title: "Daemon",
    description:
      "janelad runs your terminals, which is why they survive closing the window. It exits on its own when nothing is live.",
    sections: [DAEMON_STATE_SECTION, DAEMON_STOP_SECTION],
  },
];

export const PROJECT_PANE_DESCRIPTION =
  "Settings for one project. Every session it opens starts under these.";

export function projectSections(project: Project): readonly SettingsSection[] {
  return [
    PROJECT_SESSIONS_SECTION,
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
