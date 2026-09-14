import type {
  LaunchProfile,
  LaunchProfileAvailability,
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

import type { Clipboard, CommandSource, NativeShell } from "./client-environment.tsx";
import type { ConfirmationQueue, ConfirmationRequest } from "./confirmation.ts";
import {
  DEFAULT_GLOBAL_SETTINGS,
  type ConfirmationKey,
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
 * Cancelling the directory dialog is the interesting default: a test that wanted
 * a path says so, and one that forgot cannot accidentally assert on a project
 * nobody chose.
 */
export function inertNativeShell(): RecordingNativeShell {
  const calls: string[] = [];
  return {
    calls,
    pickDirectory(options) {
      calls.push(`pickDirectory:${options.title}`);
      return Promise.resolve(undefined);
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

/**
 * A queue that records the questions and answers them the same way every time.
 *
 * `agrees: false` by default, for the reason `inertNativeShell` refuses: a test
 * that has not said the user agreed must not be able to observe the consequence
 * of agreeing. `titles` is what an assertion reads — the copy itself is tested
 * where it is written (`sidebar-actions.test.ts`), not here.
 */
export function recordingConfirmations(options?: {
  readonly agrees?: boolean;
  /** Questions this fake treats as silenced: asked for, never shown, agreed. */
  readonly silenced?: readonly ConfirmationKey[];
}): RecordingConfirmations {
  const asked: ConfirmationRequest[] = [];
  const silenced = options?.silenced ?? [];
  return {
    asked,
    get titles(): readonly string[] {
      return asked.map((request) => request.title);
    },
    pending: undefined,
    confirm(request) {
      if (request.remember !== undefined && silenced.includes(request.remember))
        return Promise.resolve(true);
      asked.push(request);
      return Promise.resolve(options?.agrees === true);
    },
    answer() {
      // Nothing is on screen: this fake answers inside `confirm`.
    },
    subscribe() {
      return () => undefined;
    },
  };
}

export interface RecordingConfirmations extends ConfirmationQueue {
  /** Every question asked, in order, whole — so a test can assert on the copy. */
  readonly asked: ConfirmationRequest[];
  readonly titles: readonly string[];
}

export interface RecordingNativeShell extends NativeShell {
  readonly calls: string[];
}

/**
 * A clipboard that remembers what was copied and hands it back on paste.
 *
 * Empty to begin with, so `paste` answers `undefined` — the refusal a real
 * clipboard gives when there is nothing on it, and the case a terminal has to
 * survive without sending a stray byte.
 */
export function recordingClipboard(initial?: string): RecordingClipboard {
  let held = initial;
  const calls: string[] = [];
  return {
    calls,
    get text(): string | undefined {
      return held;
    },
    copy(text) {
      calls.push(`copy:${text}`);
      held = text;
      return Promise.resolve();
    },
    paste() {
      calls.push("paste");
      return Promise.resolve(held);
    },
  };
}

export interface RecordingClipboard extends Clipboard {
  readonly calls: string[];
  /** What was last copied, or what the clipboard was seeded with. */
  readonly text: string | undefined;
}

/** A clipboard nothing can be put on or taken off. */
export function inertClipboard(): Clipboard {
  return {
    copy: () => Promise.resolve(),
    paste: () => Promise.resolve(undefined),
  };
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
    paste(text) {
      calls.push(`paste:${text}`);
    },
    focus() {
      calls.push("focus");
    },
    viewport: () => undefined,
  };
}

export interface RecordingSurfaceHandle extends TerminalSurfaceHandle {
  readonly calls: string[];
}
