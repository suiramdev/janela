import type {
  LaunchProfile,
  LaunchProfileAvailability,
  LaunchProfileID,
  Project,
  ProjectSettings,
  Session,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  absolutePath,
  newLaunchProfileID,
  newProjectID,
  newSessionID,
  newTerminalID,
  now,
  singleTerminalLayout,
} from "@janela/core";
import type { TerminalSurfaceHandle } from "@janela/terminal-ui";

import type { CommandSource, NativeShell } from "./client-environment.tsx";
import {
  DEFAULT_GLOBAL_SETTINGS,
  type GlobalSettings,
  type SettingsStoring,
} from "./global-settings.ts";

/**
 * Fixtures for this package's own tests.
 *
 * Deliberately **not** re-exported from `index.ts` and nothing ships them. A
 * client package may not import another package's test fakes either, so where
 * these overlap with `@janela/client`'s they were written again rather than
 * reached for.
 */

export function fakeProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: newLaunchProfileID(),
    name: "Claude Code",
    iconName: "sparkles",
    command: ["claude"],
    environment: {},
    isAgent: true,
    isBuiltIn: false,
    ...overrides,
  };
}

/** The login-shell profile: an empty argv, which is available by rule. */
export function fakeShellProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return fakeProfile({
    name: "Shell",
    iconName: "terminal",
    command: [],
    isAgent: false,
    isBuiltIn: true,
    ...overrides,
  });
}

/** Availability as the daemon would report it: every profile named, explicitly. */
export function reportedAvailable(
  ...profiles: readonly LaunchProfile[]
): LaunchProfileAvailability {
  return Object.fromEntries(profiles.map((profile) => [profile.id, true]));
}

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
    automation: [],
    isForgeEnabled: true,
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

/** A project that is a plain folder: no git, so no worktree sessions. */
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

/** Terminal states keyed by id, the shape `StateUpdate` carries. */
export function states(
  ...entries: readonly [TerminalID, TerminalState][]
): Readonly<Record<TerminalID, TerminalState>> {
  return Object.fromEntries(entries);
}

export interface RecordingProfileEditing {
  readonly saved: LaunchProfile[];
  readonly removed: LaunchProfileID[];
  save(profile: LaunchProfile): void;
  remove(profileID: LaunchProfileID): void;
}

export function recordingProfileEditing(): RecordingProfileEditing {
  const saved: LaunchProfile[] = [];
  const removed: LaunchProfileID[] = [];
  return {
    saved,
    removed,
    save(profile) {
      saved.push(profile);
    },
    remove(profileID) {
      removed.push(profileID);
    },
  };
}

export interface RecordingService {
  readonly calls: string[];
  stop(): void;
  stopAndUnregister(): void;
}

export function recordingService(): RecordingService {
  const calls: string[] = [];
  return {
    calls,
    stop() {
      calls.push("stop");
    },
    stopAndUnregister() {
      calls.push("stopAndUnregister");
    },
  };
}

/**
 * A shell that answers "no" to everything a person would have answered.
 *
 * Cancelling a dialog and refusing a confirmation are the interesting defaults: a
 * test that wanted the other answer says so, and one that forgot cannot
 * accidentally assert on a path a user never agreed to.
 */
export function inertNativeShell(): RecordingNativeShell {
  const calls: string[] = [];
  return {
    calls,
    pickDirectory(options) {
      calls.push(`pickDirectory:${options.title}`);
      return Promise.resolve(undefined);
    },
    confirm(options) {
      calls.push(`confirm:${options.title}`);
      return Promise.resolve(false);
    },
    revealInFinder(path) {
      calls.push(`revealInFinder:${path}`);
      return Promise.resolve();
    },
    openInTerminal(path) {
      calls.push(`openInTerminal:${path}`);
      return Promise.resolve();
    },
  };
}

export interface RecordingNativeShell extends NativeShell {
  readonly calls: string[];
}

/** A command source nothing ever emits from. */
export function neverCommands(): CommandSource {
  return { subscribe: () => () => {} };
}

/** Settings that survive as long as the fake does. */
export function memorySettingsStore(initial = DEFAULT_GLOBAL_SETTINGS): RecordingSettingsStore {
  let stored = initial;
  const saved: GlobalSettings[] = [];
  return {
    saved,
    load: () => Promise.resolve(stored),
    save(settings) {
      stored = settings;
      saved.push(settings);
      return Promise.resolve();
    },
  };
}

export interface RecordingSettingsStore extends SettingsStoring {
  readonly saved: GlobalSettings[];
}

/** A mounted terminal surface, recording only what the view state asks of it. */
export function fakeSurfaceHandle(): RecordingSurfaceHandle {
  const calls: string[] = [];
  return {
    calls,
    feed: () => {},
    clearViewport() {
      calls.push("clearViewport");
    },
    selectedText: () => undefined,
    focus() {
      calls.push("focus");
    },
    viewport: () => undefined,
  };
}

export interface RecordingSurfaceHandle extends TerminalSurfaceHandle {
  readonly calls: string[];
}
