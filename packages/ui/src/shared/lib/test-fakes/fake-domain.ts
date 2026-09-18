import type {
  Project,
  ProjectSettings,
  Session,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  absolutePath,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  singleTerminalLayout,
} from "@janela/core";

export function fakeTerminal(overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor {
  return {
    id: newTerminalID(),
    title: "zsh",
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: now(),
    ...overrides,
  };
}

export function fakeSession(overrides: Partial<Session> = {}): Session {
  const terminals = overrides.terminals ?? [fakeTerminal()];
  const first = terminals[0]?.id ?? newTerminalID();

  return {
    id: newSessionID(),
    name: "main",
    directory: absolutePath("/tmp/janela-fake"),
    backing: { kind: "folder" },
    layout: singleTerminalLayout(first),
    accent: "none",
    createdAt: now(),
    lastActiveAt: now(),
    isPinned: false,
    ...overrides,
    terminals,
  };
}

export function fakeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    worktreeRoot: { kind: "siblingDirectory" },
    automation: {},
    ...overrides,
  };
}

export function fakeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "janela",
    directory: absolutePath("/tmp/janela-fake-project"),
    git: { defaultBranch: "main" },
    settings: fakeSettings(),
    accent: "none",
    isExpanded: true,
    addedAt: now(),
    ...overrides,
  };
}

export function fakeFolderProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newProjectID(),
    name: "notes",
    directory: absolutePath("/tmp/janela-fake-folder"),
    settings: fakeSettings(),
    accent: "none",
    isExpanded: true,
    addedAt: now(),
    ...overrides,
  };
}

export function states(
  ...entries: readonly [TerminalID, TerminalState][]
): Readonly<Record<TerminalID, TerminalState>> {
  return Object.fromEntries(entries);
}
