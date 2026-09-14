import { describe, expect, test } from "bun:test";

import type {
  ConnectionStatus,
  DaemonConnection,
  ProjectStore,
  SessionStore,
} from "@janela/client";
import {
  absolutePath,
  emptyLayout,
  instant,
  type Session,
  type SessionID,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import { renderToStaticMarkup } from "react-dom/server";

import { ClientEnvironmentProvider, type ClientEnvironment } from "./client-environment.tsx";
import {
  ConnectionBanner,
  VERSION_SKEW_COPY,
  bannerModel,
  runningSummary,
} from "./connection-banner.tsx";
import {
  inertClipboard,
  inertNativeShell,
  recordingConfirmations,
  memorySettingsStore,
  neverCommands,
  recordingService,
} from "./test-fakes.ts";
import { createViewState } from "./view-state.ts";

const AT = instant("2026-01-01T00:00:00.000Z");

const sessionID = (raw: string): SessionID => raw as SessionID;
const terminalID = (raw: string): TerminalID => raw as TerminalID;

function terminal(id: string): TerminalDescriptor {
  return {
    id: terminalID(id),
    title: id,
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: AT,
  };
}

function session(id: string, terminals: readonly TerminalDescriptor[] = []): Session {
  return {
    id: sessionID(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    backing: { kind: "folder" },
    terminals,
    layout: emptyLayout,
    accent: "none",
    createdAt: AT,
    lastActiveAt: AT,
    isPinned: false,
  };
}

/** A subscription that never notifies. */
const noop = (): (() => void) => () => {};

function fakeEnvironment(options: {
  readonly status: ConnectionStatus;
  readonly sessions?: readonly Session[];
  readonly states?: Readonly<Record<TerminalID, TerminalState>>;
  readonly onRestart?: () => void;
}): ClientEnvironment {
  const sessions = options.sessions ?? [];
  const states = options.states ?? {};

  const projects: ProjectStore = { projects: [], find: () => undefined, subscribe: noop };
  const sessionStore: SessionStore = {
    sessions,
    selection: undefined,
    terminalStates: states,
    launchProfiles: [],
    launchProfileAvailability: {},
    inProject: () => [],
    standaloneSessions: sessions,
    isRunning: (id) => {
      const found = sessions.find((candidate) => candidate.id === id);
      return (found?.terminals ?? []).some((entry) => states[entry.id]?.kind === "running");
    },
    subscribe: noop,
  };
  const connection: DaemonConnection = {
    status: options.status,
    isStale: options.status.kind !== "connected",
    connect: async () => {},
    request: async () => undefined,
    sendInput: () => {},
    onOutput: noop,
    onAttention: noop,
    subscribe: noop,
    disconnect: async () => {},
  };

  return {
    projects,
    sessions: sessionStore,
    connection,
    view: createViewState(sessionStore),
    commands: neverCommands(),
    native: inertNativeShell(),
    confirmations: recordingConfirmations(),
    clipboard: inertClipboard(),
    settings: memorySettingsStore(),
    service: recordingService(),
    restartDaemon: options.onRestart ?? (() => {}),
  };
}

function markupFor(environment: ClientEnvironment): string {
  return renderToStaticMarkup(
    <ClientEnvironmentProvider environment={environment}>
      <ConnectionBanner />
    </ClientEnvironmentProvider>,
  );
}

describe("bannerModel", () => {
  test("idle and connected show nothing", () => {
    expect(bannerModel({ kind: "idle" })).toEqual({ kind: "none" });
    expect(bannerModel({ kind: "connected" })).toEqual({ kind: "none" });
  });

  test("connecting and reconnecting are one quiet line each", () => {
    expect(bannerModel({ kind: "connecting" })).toEqual({ kind: "strip", text: "Connecting…" });
    expect(bannerModel({ kind: "reconnecting", attempt: 7 })).toEqual({
      kind: "strip",
      // The attempt count is deliberately absent: a counter turns a non-event
      // into something to watch.
      text: "Reconnecting…",
    });
  });

  test("refused is its own case, because it needs a decision", () => {
    expect(
      bannerModel({
        kind: "refused",
        refusal: { kind: "incompatibleVersion", daemonMinimum: 1, daemonCurrent: 1 },
      }),
    ).toEqual({ kind: "refused" });
  });
});

describe("runningSummary", () => {
  test("counts sessions and the live ones", () => {
    expect(
      runningSummary([session("a"), session("b"), session("c")], (id) => id === sessionID("a")),
    ).toBe("3 sessions, 1 with a live terminal");
  });

  test("plurals both ways", () => {
    expect(runningSummary([session("a")], () => false)).toBe("1 session, 0 with live terminals");
    expect(runningSummary([session("a"), session("b")], () => true)).toBe(
      "2 sessions, 2 with live terminals",
    );
  });

  test("no sessions is not '0 sessions'", () => {
    expect(runningSummary([], () => false)).toBe("No sessions");
  });
});

describe("ConnectionBanner markup", () => {
  test("connected renders nothing at all", () => {
    expect(markupFor(fakeEnvironment({ status: { kind: "connected" } }))).toBe("");
  });

  test("reconnecting is a polite live region overlaid, never inserted", () => {
    const markup = markupFor(fakeEnvironment({ status: { kind: "reconnecting", attempt: 1 } }));

    // `absolute` is the no-layout-shift guarantee: a terminal that jumped a few
    // pixels every time the daemon restarted would be worse than no banner.
    expect(markup).toContain("absolute inset-x-0 top-0");
    expect(markup).toContain("<output");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Reconnecting…");
  });

  test("refused states the settled copy, the cost, and one button", () => {
    const markup = markupFor(
      fakeEnvironment({
        status: {
          kind: "refused",
          refusal: { kind: "incompatibleVersion", daemonMinimum: 1, daemonCurrent: 1 },
        },
        sessions: [session("a", [terminal("t1")]), session("b")],
        states: { [terminalID("t1")]: { kind: "running" } },
      }),
    );

    expect(markup).toContain(VERSION_SKEW_COPY);
    expect(markup).toContain("2 sessions, 1 with a live terminal");
    expect(markup).toContain("Restart the background service");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("absolute");
  });

  test("the copy says what happened, what is still running, and what it costs", () => {
    expect(VERSION_SKEW_COPY).toBe(
      "Janela was updated. The background service is still running your terminals on the previous version. Restart it when you are ready — this will close your terminals.",
    );
  });
});
