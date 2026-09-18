import { afterEach, describe, expect, test } from "bun:test";

import type {
  GridSize,
  IntegrationReport,
  LaunchProfile,
  LaunchProfileID,
  PaneDestination,
  Project,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import { absolutePath } from "@janela/core";
import {
  FrameKind,
  decodeDaemonMessage,
  encodeClientMessage,
  encodeInput,
  parseBranchOverview,
  parseDirectoryListing,
  parseIntegrationOverview,
  parseRemovalPlan,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type RequestID,
  type SessionRemovalPreview,
} from "@janela/protocol";
import type {
  DirectoryBrowsing,
  LaunchProfileService,
  NewTerminalOptions,
  ProjectBranchOverview,
  ProjectService,
  SessionCreationRequest,
  SessionRemovalPlan,
  SessionService,
} from "@janela/session";
import { UserFacingError } from "@janela/support";

import { createDaemonServer, type DaemonServer } from "./server.ts";
import {
  clientHello,
  fakeDirectories,
  fakeIntegrations,
  fakeListing,
  fakeLaunchProfiles,
  fakeProfile,
  fakeProjects,
  fakeRegistry,
  fakeSession,
  fakeSessions,
  fakeTerminal,
  memoryListener,
  recordingLogger,
  wireControl,
  type FakeIntegrations,
  type FakeRegistry,
  type FakeTerminal,
  type Recorded,
  type WireValue,
} from "./test-fakes.ts";

interface Peer {
  send(frame: Frame): Promise<void>;
  readonly controls: DaemonMessage[];
  reply(id: RequestID): Promise<DaemonMessage>;
  readonly frames: Frame[];
  receive(): Promise<Frame>;
  close(): Promise<void>;
}

interface Fixture {
  readonly server: DaemonServer;
  readonly registry: FakeRegistry;
  readonly records: Recorded[];
  with(message: string): Recorded[];
  connect(options?: { readonly drains?: boolean }): Promise<Peer>;
  stop(): Promise<void>;
}

const VIEWPORT: GridSize = { columns: 80, rows: 24 };
const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;

const STDERR = "fatal: could not read Username for https://example.invalid";

const running: Fixture[] = [];

const request = (message: ClientMessage): Frame => encodeClientMessage(message);

const plan = (overrides: Partial<SessionRemovalPlan> = {}): SessionRemovalPlan => ({
  liveTerminalCount: 2,
  canDeleteDirectory: true,
  deletesDirectory: false,
  includedPaths: [".env"],
  runsTeardownAutomation: true,
  safety: {
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    hasUnpushedCommits: false,
    isLocked: false,
    hasRunningSessions: true,
  },
  ...overrides,
});

class GitFailure extends UserFacingError {
  override readonly summary = "Couldn't create the session.";
}

class TerminalNotRunning extends UserFacingError {
  override readonly summary = "That terminal isn't running.";

  constructor() {
    super("pseudo-terminal not running");
  }
}

class BuiltInProfile extends UserFacingError {
  override readonly summary = "Built-in profiles can't be deleted.";

  constructor() {
    super("built-in launch profile cannot be removed", {
      recoverySuggestion: "Edit it instead, or copy it and edit the copy.",
    });
  }
}

function fakeDescriptor(id: TerminalID): TerminalDescriptor {
  return {
    id,
    title: "Shell",
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: "2026-01-01T00:00:00.000Z" as TerminalDescriptor["createdAt"],
  };
}

async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;

    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }

  throw new Error(`timed out waiting for ${description}`);
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((active) => active.stop()));
});

function fixture(
  options: {
    readonly terminals?: readonly FakeTerminal[];
    readonly sessions?: readonly Session[];
    readonly projects?: readonly Project[];
    readonly sessionOverrides?: Partial<SessionService>;
    readonly projectOverrides?: Partial<ProjectService>;
    readonly profiles?: readonly LaunchProfile[];
    readonly profileOverrides?: Partial<LaunchProfileService>;
    readonly directories?: DirectoryBrowsing;
    readonly integrations?: FakeIntegrations;
  } = {},
): Fixture {
  const registry = fakeRegistry(options.terminals ?? []);
  const { logger, records, with: withMessage } = recordingLogger();
  const listener = memoryListener();
  const controller = new AbortController();

  const server = createDaemonServer({
    sessions: fakeSessions(options.sessions ?? [], options.sessionOverrides ?? {}),
    projects: fakeProjects(options.projects ?? [], options.projectOverrides ?? {}),
    launchProfiles: fakeLaunchProfiles(options.profiles ?? [], options.profileOverrides ?? {}),
    directories: options.directories ?? fakeDirectories(),
    terminals: registry,
    integrations: options.integrations ?? fakeIntegrations(),
    log: logger,
    handshakeDeadlineMs: 250,
  });

  const serving = server.serve(listener, controller.signal);

  const value: Fixture = {
    server,
    registry,
    records,
    with: withMessage,
    async connect(connectOptions: { readonly drains?: boolean } = {}): Promise<Peer> {
      const pair = listener.connect();
      const transport = pair.clientSide;
      const frames: Frame[] = [];
      const controls: DaemonMessage[] = [];
      const iterator = transport.incoming()[Symbol.asyncIterator]();

      const take = async (): Promise<Frame> => {
        const next = await iterator.next();

        if (next.done === true) throw new Error("the daemon closed the connection");

        frames.push(next.value);

        if (next.value.kind === FrameKind.Control) {
          controls.push(decodeDaemonMessage(next.value));
        }

        return next.value;
      };

      const drains = connectOptions.drains ?? true;

      if (drains) {
        void (async () => {
          for (;;) {
            // oxlint-disable-next-line no-await-in-loop
            await take();
          }
        })().catch(() => {});
      }

      await transport.send(clientHello());

      if (drains) await until(() => controls.length > 0, "the daemon's hello");
      else await take();

      return {
        frames,
        controls,
        receive: take,
        send: (frame) => transport.send(frame),
        async reply(id: RequestID): Promise<DaemonMessage> {
          await until(() => correlated(controls, id) !== undefined, `a reply to request ${id}`);
          const message = correlated(controls, id);

          if (message === undefined) throw new Error("no reply");

          return message;
        },
        close: () => transport.close(),
      };
    },
    async stop(): Promise<void> {
      controller.abort();
      await serving;
    },
  };

  running.push(value);

  return value;
}

function correlated(controls: readonly DaemonMessage[], id: RequestID): DaemonMessage | undefined {
  return controls.find(
    (message) =>
      (message.type === "acknowledged" || message.type === "failed" || message.type === "text") &&
      message.id === id,
  );
}

function everythingSaid(peer: Peer, records: readonly Recorded[]): string {
  const decoder = new TextDecoder();

  return [
    ...peer.frames.map((frame) => decoder.decode(frame.payload)),
    JSON.stringify(records),
  ].join("\n");
}

describe("terminals", () => {
  test("attaching a viewport starts nothing", async () => {
    const started: TerminalID[] = [];
    const terminal = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const daemon = fixture({
      terminals: [terminal],
      sessionOverrides: {
        startTerminal: (id) => {
          started.push(id);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: terminal.id, viewport: VIEWPORT }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(terminal.startCalls.count).toBe(0);
    expect(started).toEqual([]);
    expect(terminal.attached.get("c1")).toEqual(VIEWPORT);
  });

  test("startTerminal is the only way a process is spawned, and its failure is shown", async () => {
    const started: TerminalID[] = [];
    const terminal = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const daemon = fixture({
      terminals: [terminal],
      sessionOverrides: {
        startTerminal: (id) => {
          started.push(id);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "startTerminal", id: 1 as RequestID, terminalID: terminal.id }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(started).toEqual([terminal.id]);

    const refusing = fixture({
      terminals: [terminal],
      sessionOverrides: {
        startTerminal: () => Promise.reject(new UnavailableProfile()),
      },
    });
    const second = await refusing.connect();
    await second.send(
      request({ type: "startTerminal", id: 2 as RequestID, terminalID: terminal.id }),
    );

    expect(await second.reply(2 as RequestID)).toEqual({
      type: "failed",
      id: 2 as RequestID,
      failure: { summary: "That command isn't available." },
    });
  });

  test("a viewportless attachment types without rendering or resizing", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const reader = await daemon.connect();
    const renderer = await daemon.connect();

    await reader.send(request({ type: "attach", id: 1 as RequestID, terminalID: terminal.id }));

    expect(await reader.reply(1 as RequestID)).toEqual({
      type: "acknowledged",
      id: 1 as RequestID,
    });
    expect([...terminal.attached.keys()]).toEqual([]);

    await reader.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("q") }),
    );
    await until(() => terminal.sendCalls.length === 1, "the input to arrive");

    await reader.send(
      request({ type: "resize", terminalID: terminal.id, size: { columns: 200, rows: 60 } }),
    );
    await until(() => daemon.with("resize ignored").length === 1, "the ignored resize");

    expect(terminal.attachCalls).toEqual([]);

    await renderer.send(
      request({ type: "attach", id: 2 as RequestID, terminalID: terminal.id, viewport: VIEWPORT }),
    );
    await renderer.reply(2 as RequestID);

    expect(terminal.attachCalls).toEqual([{ client: "c2", viewport: VIEWPORT }]);
    expect(reader.frames.some((frame) => frame.kind === FrameKind.Output)).toBe(false);
  });

  test("a resize is an attach with a new viewport, from a rendering client only", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const renderer = await daemon.connect();
    const bystander = await daemon.connect();

    await renderer.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: terminal.id, viewport: VIEWPORT }),
    );
    await renderer.reply(1 as RequestID);
    await renderer.send(
      request({ type: "resize", terminalID: terminal.id, size: { columns: 120, rows: 40 } }),
    );
    await until(() => terminal.attachCalls.length === 2, "the resize upsert");

    expect(terminal.attachCalls).toEqual([
      { client: "c1", viewport: VIEWPORT },
      { client: "c1", viewport: { columns: 120, rows: 40 } },
    ]);

    await bystander.send(
      request({ type: "resize", terminalID: terminal.id, size: { columns: 10, rows: 10 } }),
    );
    await until(() => daemon.with("resize ignored").length === 1, "the ignored resize");

    expect(terminal.attachCalls).toHaveLength(2);
  });

  test("input reaches the terminal it names, and only from a connection attached to it", async () => {
    const terminal = fakeTerminal(terminalID());
    const other = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal, other] });
    const attached = await daemon.connect();
    const stranger = await daemon.connect();

    await attached.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: terminal.id, viewport: VIEWPORT }),
    );
    await attached.reply(1 as RequestID);
    await attached.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("ls\r") }),
    );
    await until(() => terminal.sendCalls.length === 1, "the input");

    expect(new TextDecoder().decode(terminal.sendCalls[0])).toBe("ls\r");
    expect(other.sendCalls).toEqual([]);

    await stranger.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("rm -rf /") }),
    );
    await until(
      () => daemon.with("input from a connection not attached").length === 1,
      "the dropped input",
    );

    expect(terminal.sendCalls).toHaveLength(1);

    await stranger.send(request({ type: "detach", id: 9 as RequestID, terminalID: terminal.id }));

    expect(await stranger.reply(9 as RequestID)).toEqual({
      type: "acknowledged",
      id: 9 as RequestID,
    });
  });

  test("a terminal that refuses input costs a log line, not the connection", async () => {
    const terminal = fakeTerminal(terminalID(), { throwOnSend: new TerminalNotRunning() });
    const daemon = fixture({ terminals: [terminal] });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: terminal.id, viewport: VIEWPORT }),
    );
    await peer.reply(1 as RequestID);
    await peer.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("ls\r") }),
    );
    await until(() => daemon.with("input failed").length === 1, "the failure record");

    expect(daemon.with("input failed")[0]?.fields).toEqual({
      client: "c1",
      error: "TerminalNotRunning",
    });

    await peer.send(request({ type: "detach", id: 2 as RequestID, terminalID: terminal.id }));

    expect(await peer.reply(2 as RequestID)).toEqual({
      type: "acknowledged",
      id: 2 as RequestID,
    });
  });

  test("a terminal that is gone is a failure a person can read, not a closed connection", async () => {
    const daemon = fixture();
    const peer = await daemon.connect();
    daemon.registry.add(fakeTerminal(terminalID()));

    await peer.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: terminalID(), viewport: VIEWPORT }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: { summary: "That terminal no longer exists." },
    });
  });

  test("snapshotText reads without attaching, which is the CLI's whole job", async () => {
    const terminal = fakeTerminal(terminalID(), { snapshot: "on screen" });
    const daemon = fixture({ terminals: [terminal] });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "snapshotText",
        id: 1 as RequestID,
        terminalID: terminal.id,
        includeScrollback: false,
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "text",
      id: 1 as RequestID,
      text: "on screen",
    });
    expect([...terminal.attached.keys()]).toEqual([]);
  });

  test("the frame loop never encodes for an attachment that has no viewport", async () => {
    const rendered = fakeTerminal(terminalID());
    const read = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [rendered, read] });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "attach", id: 1 as RequestID, terminalID: rendered.id, viewport: VIEWPORT }),
    );
    await peer.reply(1 as RequestID);
    await peer.send(request({ type: "attach", id: 2 as RequestID, terminalID: read.id }));
    await peer.reply(2 as RequestID);

    for (let index = 0; index < 3; index += 1) {
      daemon.server.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    expect(read.fullRepaintCalls).toEqual([]);
    expect(read.repaintCalls).toEqual([]);
    expect(rendered.fullRepaintCalls).toEqual(["c1"]);
  });
});

describe("state", () => {
  test("subscribing answers with the whole world, before the acknowledgement", async () => {
    const first = fakeSession("s1");
    const second = fakeSession("s2");
    const terminal = fakeTerminal(terminalID(), {
      state: { kind: "idle" },
      sessionID: second.id,
    });
    const profile = fakeProfile("p1");
    const daemon = fixture({
      sessions: [first, second],
      profiles: [profile],
      projects: [],
      terminals: [terminal],
    });
    const peer = await daemon.connect();

    await peer.send(request({ type: "subscribe", id: 1 as RequestID, scope: { kind: "state" } }));
    await peer.reply(1 as RequestID);

    const [, state, acknowledged] = peer.controls;

    expect(state).toEqual({
      type: "state",
      update: {
        projects: [],
        sessions: [first, second],
        terminalStates: { [terminal.id]: { kind: "idle" } },
        launchProfiles: [profile],
        launchProfileAvailability: { [profile.id]: true },
        isFullSnapshot: true,
      },
    });
    expect(acknowledged).toEqual({ type: "acknowledged", id: 1 as RequestID });
  });

  test("a removal propagates, because every announcement is the complete list", async () => {
    const survivor = fakeSession("s1");
    const removed = fakeSession("s2");
    const daemon = fixture({ sessions: [survivor, removed] });
    const peer = await daemon.connect();

    await peer.send(request({ type: "subscribe", id: 1 as RequestID, scope: { kind: "state" } }));
    await peer.reply(1 as RequestID);
    await daemon.server.sessionsChanged([survivor]);
    await until(
      () => peer.controls.filter((message) => message.type === "state").length === 2,
      "the announcement",
    );

    const announced = peer.controls.findLast((message) => message.type === "state");

    expect(announced).toEqual({
      type: "state",
      update: {
        projects: [],
        sessions: [survivor],
        terminalStates: {},
        launchProfiles: [],
        launchProfileAvailability: {},
        isFullSnapshot: true,
      },
    });
  });
});

describe("sessions", () => {
  test("a removal plan round-trips as text", async () => {
    const asked: SessionID[] = [];
    const daemon = fixture({
      sessionOverrides: {
        removalPlan: (id) => {
          asked.push(id);

          return Promise.resolve(plan());
        },
      },
    });
    const peer = await daemon.connect();
    const sessionID = "s1" as SessionID;

    await peer.send(request({ type: "removalPlan", id: 1 as RequestID, sessionID }));
    const reply = await peer.reply(1 as RequestID);

    if (reply.type !== "text") throw new Error(`expected text, got ${reply.type}`);

    const preview: SessionRemovalPreview = parseRemovalPlan(reply.text);

    expect(preview).toEqual(plan());
    expect(asked).toEqual([sessionID]);
  });

  test("removeSession recomputes the plan and applies only the client's directory answer", async () => {
    const plans: SessionRemovalPlan[] = [];
    const removals: { id: SessionID; plan: SessionRemovalPlan }[] = [];
    const daemon = fixture({
      sessionOverrides: {
        removalPlan: () => {
          const fresh = plan();
          plans.push(fresh);

          return Promise.resolve(fresh);
        },
        removeSession: (id, applied) => {
          removals.push({ id, plan: applied });

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();
    const sessionID = "s1" as SessionID;

    await peer.send(
      request({ type: "removeSession", id: 1 as RequestID, sessionID, deletesDirectory: true }),
    );
    await peer.reply(1 as RequestID);
    await peer.send(
      request({ type: "removeSession", id: 2 as RequestID, sessionID, deletesDirectory: false }),
    );
    await peer.reply(2 as RequestID);

    expect(removals.map((removal) => removal.plan.deletesDirectory)).toEqual([true, false]);
    expect(removals[0]?.plan).toBe(plans[0]);
    expect(removals[1]?.plan).toBe(plans[1]);
    expect(plans).toHaveLength(2);
  });

  test("marking a session read lowers attention on each live terminal and announces it", async () => {
    const session = fakeSession("s1");
    const bell = fakeTerminal(terminalID(), {
      sessionID: session.id,
      state: { kind: "needsAttention" },
    });
    const finished = fakeTerminal(terminalID(), {
      sessionID: session.id,
      state: { kind: "needsAttention", activity: { kind: "finished", outcome: "completed" } },
    });
    const elsewhere = fakeTerminal(terminalID(), { state: { kind: "needsAttention" } });
    const daemon = fixture({ sessions: [session], terminals: [bell, finished, elsewhere] });
    const peer = await daemon.connect();

    await peer.send(request({ type: "subscribe", id: 1 as RequestID, scope: { kind: "state" } }));
    await peer.reply(1 as RequestID);
    await peer.send(
      request({ type: "markSession", id: 2 as RequestID, sessionID: session.id, unread: false }),
    );

    expect(await peer.reply(2 as RequestID)).toEqual({ type: "acknowledged", id: 2 as RequestID });
    expect(bell.state).toEqual({ kind: "running" });
    expect(finished.state).toEqual({
      kind: "running",
      activity: { kind: "finished", outcome: "completed" },
    });
    expect(elsewhere.markCalls).toEqual([]);

    const announced = peer.controls.filter(
      (message) => message.type === "state" && !message.update.isFullSnapshot,
    );

    expect(
      announced.map((message) => (message.type === "state" ? message.update.terminalStates : {})),
    ).toEqual([{ [bell.id]: { kind: "running" } }, { [finished.id]: finished.state }]);
  });

  test("marking a session unread raises attention on a quiet terminal", async () => {
    const session = fakeSession("s1");
    const shell = fakeTerminal(terminalID(), { sessionID: session.id });
    const daemon = fixture({ sessions: [session], terminals: [shell] });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "markSession", id: 1 as RequestID, sessionID: session.id, unread: true }),
    );

    expect((await peer.reply(1 as RequestID)).type).toBe("acknowledged");
    expect(shell.state).toEqual({ kind: "needsAttention" });
  });

  test("marking an unknown session fails, and a verdict that is not a boolean is refused", async () => {
    const session = fakeSession("s1");
    const shell = fakeTerminal(terminalID(), { sessionID: session.id });
    const daemon = fixture({ sessions: [session], terminals: [shell] });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "markSession",
        id: 1 as RequestID,
        sessionID: "nobody" as SessionID,
        unread: true,
      }),
    );

    expect((await peer.reply(1 as RequestID)).type).toBe("failed");

    for (const [index, unread] of ["true", 1, null].entries()) {
      const id = (index + 2) as RequestID;
      // oxlint-disable-next-line no-await-in-loop
      await peer.send(wireControl({ type: "markSession", id, sessionID: session.id, unread }));
      // oxlint-disable-next-line no-await-in-loop
      expect((await peer.reply(id)).type).toBe("failed");
    }

    expect(shell.markCalls).toEqual([]);
  });

  test("a failure crosses the wire as a summary, and stderr appears nowhere", async () => {
    const daemon = fixture({
      sessionOverrides: {
        createSession: () => Promise.reject(new GitFailure(`git failed: ${STDERR}`)),
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createSession",
        id: 1 as RequestID,
        intent: { kind: "inProject", projectID: "p1" as Project["id"] },
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: { summary: "Couldn't create the session." },
    });
    expect(everythingSaid(peer, daemon.records)).not.toContain(STDERR);
    expect(daemon.with("request failed")[0]?.fields).toEqual({
      client: "c1",
      type: "createSession",
      error: "GitFailure",
    });
  });

  test("an error nobody wrote for a person becomes one sentence and a log line", async () => {
    const daemon = fixture({
      sessionOverrides: {
        createSession: () => Promise.reject(new Error(STDERR)),
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createSession",
        id: 1 as RequestID,
        intent: { kind: "standalone", directory: "/tmp/x" as Session["directory"] },
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: {
        summary: "Couldn't complete the request.",
        recoverySuggestion: "If this keeps happening, please file an issue with the log.",
      },
    });
    expect(everythingSaid(peer, daemon.records)).not.toContain(STDERR);
  });

  test("a branch overview round-trips as text", async () => {
    const asked: Project["id"][] = [];
    const overview: ProjectBranchOverview = {
      branches: ["main", "feat/pty"],
      worktrees: [
        { directory: "/Users/x/code/janela" as Session["directory"], branch: "main", isMain: true },
        {
          directory: "/Users/x/code/.worktrees/feat-pty" as Session["directory"],
          branch: "feat/pty",
          isMain: false,
        },
        { directory: "/Users/x/code/.worktrees/spike" as Session["directory"], isMain: false },
      ],
    };
    const daemon = fixture({
      sessionOverrides: {
        branchOverview: (id) => {
          asked.push(id);

          return Promise.resolve(overview);
        },
      },
    });
    const peer = await daemon.connect();
    const projectID = "p1" as Project["id"];

    await peer.send(request({ type: "projectBranches", id: 1 as RequestID, projectID }));
    const reply = await peer.reply(1 as RequestID);

    if (reply.type !== "text") throw new Error(`expected text, got ${reply.type}`);

    expect(parseBranchOverview(reply.text)).toEqual(overview);
    expect(asked).toEqual([projectID]);
  });

  test("a project with no git is refused, not answered with an empty overview", async () => {
    class NoGit extends UserFacingError {
      override readonly summary = "This project isn't a git repository.";
    }

    const daemon = fixture({
      sessionOverrides: { branchOverview: () => Promise.reject(new NoGit("not a repository")) },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "projectBranches",
        id: 1 as RequestID,
        projectID: "p1" as Project["id"],
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: { summary: "This project isn't a git repository." },
    });
  });

  test("a directory listing round-trips as text, and no directory asks for the home", async () => {
    const asked: (string | undefined)[] = [];
    const listing = fakeListing();
    const daemon = fixture({
      directories: fakeDirectories((directory) => {
        asked.push(directory);

        return Promise.resolve(listing);
      }),
    });
    const peer = await daemon.connect();

    await peer.send(request({ type: "listDirectory", id: 1 as RequestID }));
    const home = await peer.reply(1 as RequestID);

    await peer.send(
      request({ type: "listDirectory", id: 2 as RequestID, directory: absolutePath("/tmp") }),
    );
    const named = await peer.reply(2 as RequestID);

    if (home.type !== "text") throw new Error(`expected text, got ${home.type}`);

    expect(parseDirectoryListing(home.text)).toEqual(listing);
    expect(named.type).toBe("text");
    expect(asked).toEqual([undefined, "/tmp"]);
  });

  test("a directory that is not absolute never reaches the filesystem", async () => {
    const asked: (string | undefined)[] = [];
    const daemon = fixture({
      directories: fakeDirectories((directory) => {
        asked.push(directory);

        return Promise.resolve(fakeListing());
      }),
    });
    const peer = await daemon.connect();

    await peer.send(wireControl({ type: "listDirectory", id: 1, directory: "code/../../etc" }));

    expect((await peer.reply(1 as RequestID)).type).toBe("failed");
    expect(asked).toEqual([]);
  });

  test("a folder the daemon cannot read is refused with its reason, and only its name is logged", async () => {
    class Sealed extends UserFacingError {
      override readonly summary = "Couldn't open that folder.";

      constructor() {
        super("directory unreadable: EACCES", {
          reason: "You don't have permission to read it.",
        });
      }
    }

    const daemon = fixture({
      directories: fakeDirectories(() => Promise.reject(new Sealed())),
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "listDirectory",
        id: 1 as RequestID,
        directory: absolutePath("/Users/ada/sealed"),
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: {
        summary: "Couldn't open that folder.",
        reason: "You don't have permission to read it.",
      },
    });
    expect(daemon.with("request failed").map((record) => record.fields)).toEqual([
      { client: expect.any(String), type: "listDirectory", error: "Sealed" },
    ]);
  });

  test("moveTab reaches the brain and is acknowledged", async () => {
    const moves: { id: SessionID; from: number; to: number }[] = [];
    const daemon = fixture({
      sessionOverrides: {
        moveTab: (id, from, to) => {
          moves.push({ id, from, to });

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();
    const sessionID = "s1" as SessionID;

    await peer.send(request({ type: "moveTab", id: 1 as RequestID, sessionID, from: 2, to: 0 }));

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(moves).toEqual([{ id: sessionID, from: 2, to: 0 }]);
  });

  test("an impossible tab index is refused, and the brain is not called", async () => {
    const moves: number[] = [];
    const daemon = fixture({
      sessionOverrides: {
        moveTab: () => {
          moves.push(1);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();
    const impossible: readonly { readonly from: WireValue; readonly to: WireValue }[] = [
      { from: "0", to: 1 },
      { from: 0, to: null },
      { from: -1, to: 0 },
      { from: 0, to: 1.5 },
      { from: Number.NaN, to: 0 },
    ];

    for (const [index, indices] of impossible.entries()) {
      const id = (index + 1) as RequestID;
      // oxlint-disable-next-line no-await-in-loop
      await peer.send(wireControl({ type: "moveTab", id, sessionID: "s1", ...indices }));
      // oxlint-disable-next-line no-await-in-loop
      expect((await peer.reply(id)).type).toBe("failed");
    }

    expect(moves).toEqual([]);
  });

  test("moveTerminal reaches the brain and is acknowledged", async () => {
    const moves: { id: SessionID; terminal: TerminalID; destination: PaneDestination }[] = [];
    const daemon = fixture({
      sessionOverrides: {
        moveTerminal: (id, terminal, destination) => {
          moves.push({ id, terminal, destination });

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();
    const sessionID = "s1" as SessionID;
    const moved = terminalID();
    const destination: PaneDestination = { kind: "beside", terminal: terminalID(), edge: "left" };

    await peer.send(
      request({
        type: "moveTerminal",
        id: 1 as RequestID,
        sessionID,
        terminalID: moved,
        destination,
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(moves).toEqual([{ id: sessionID, terminal: moved, destination }]);
  });

  test("an impossible destination is refused, and the brain is not called", async () => {
    const moves: number[] = [];
    const daemon = fixture({
      sessionOverrides: {
        moveTerminal: () => {
          moves.push(1);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();
    const impossible: readonly WireValue[] = [
      { kind: "beside", terminal: "t1", edge: "left" },
      { kind: "beside", terminal: terminalID(), edge: "middle" },
      { kind: "tab", index: -1 },
      { kind: "tab", index: "0" },
      { kind: "sideways" },
      null,
    ];

    for (const [index, destination] of impossible.entries()) {
      const id = (index + 1) as RequestID;
      // oxlint-disable-next-line no-await-in-loop
      await peer.send(
        wireControl({
          type: "moveTerminal",
          id,
          sessionID: "s1",
          terminalID: terminalID(),
          destination,
        }),
      );
      // oxlint-disable-next-line no-await-in-loop
      expect((await peer.reply(id)).type).toBe("failed");
    }

    expect(moves).toEqual([]);
  });

  test("an inProject intent carries its branch to the brain, and omits it when absent", async () => {
    const intents: SessionCreationRequest[] = [];
    const daemon = fixture({
      sessionOverrides: {
        createSession: (received) => {
          intents.push(received);

          return Promise.resolve(fakeSession("s1"));
        },
      },
    });
    const peer = await daemon.connect();
    const projectID = "p1" as Project["id"];

    await peer.send(
      request({
        type: "createSession",
        id: 1 as RequestID,
        intent: { kind: "inProject", projectID, branch: "feat/pty" },
      }),
    );
    await peer.reply(1 as RequestID);
    await peer.send(
      request({
        type: "createSession",
        id: 2 as RequestID,
        intent: { kind: "inProject", projectID },
      }),
    );
    await peer.reply(2 as RequestID);

    expect(intents).toEqual([
      { kind: "inProject", projectID, branch: "feat/pty" },
      { kind: "inProject", projectID },
    ]);
    expect(Object.hasOwn(intents[1] ?? {}, "branch")).toBe(false);
  });
});

describe("launch profiles", () => {
  test("a saved profile is stored and announced to every state subscriber", async () => {
    const saved: LaunchProfile[] = [];
    const profile = fakeProfile("p1", { name: "Claude Code", command: ["claude"] });
    const daemon = fixture({
      profiles: [profile],
      profileOverrides: {
        save: (value) => {
          saved.push(value);

          return Promise.resolve(value);
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(request({ type: "subscribe", id: 1 as RequestID, scope: { kind: "state" } }));
    await peer.reply(1 as RequestID);
    await peer.send(request({ type: "saveLaunchProfile", id: 2 as RequestID, profile }));

    expect(await peer.reply(2 as RequestID)).toEqual({
      type: "acknowledged",
      id: 2 as RequestID,
    });
    expect(saved).toEqual([profile]);

    await until(
      () => peer.controls.filter((message) => message.type === "state").length === 2,
      "the announcement",
    );
    const announced = peer.controls.findLast((message) => message.type === "state");

    expect(announced?.type === "state" ? announced.update.launchProfiles : undefined).toEqual([
      profile,
    ]);
  });

  test("a profile that is not a profile is refused, and nothing is stored", async () => {
    const saved: LaunchProfile[] = [];
    const daemon = fixture({
      profileOverrides: {
        save: (value) => {
          saved.push(value);

          return Promise.resolve(value);
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      wireControl({
        type: "saveLaunchProfile",
        id: 1,
        profile: { ...fakeProfile("p1"), command: ["zsh", null] },
      }),
    );

    expect((await peer.reply(1 as RequestID)).type).toBe("failed");
    expect(saved).toEqual([]);
  });

  test("removing a built-in is refused in the user's own words", async () => {
    const daemon = fixture({
      profileOverrides: {
        remove: () => Promise.reject(new BuiltInProfile()),
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "removeLaunchProfile",
        id: 1 as RequestID,
        profileID: "p1" as LaunchProfileID,
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "failed",
      id: 1 as RequestID,
      failure: {
        summary: "Built-in profiles can't be deleted.",
        recoverySuggestion: "Edit it instead, or copy it and edit the copy.",
      },
    });
  });

  test("createTerminal configures a terminal and answers with its id", async () => {
    const asked: { session: SessionID; profileID?: LaunchProfileID; title?: string }[] = [];
    const created = terminalID();
    const daemon = fixture({
      sessions: [fakeSession("s1")],
      sessionOverrides: {
        createTerminal: (session, options) => {
          asked.push({ session, ...options });

          return Promise.resolve(fakeDescriptor(created));
        },
        startTerminal: () => Promise.reject(new Error("nothing may start here")),
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createTerminal",
        id: 1 as RequestID,
        sessionID: "s1" as SessionID,
        profileID: "p1" as LaunchProfileID,
      }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({
      type: "text",
      id: 1 as RequestID,
      text: created,
    });
    expect(asked).toEqual([{ session: "s1" as SessionID, profileID: "p1" as LaunchProfileID }]);
  });

  test("a split placement reaches the brain intact", async () => {
    const asked: NewTerminalOptions[] = [];
    const beside = terminalID();
    const daemon = fixture({
      sessions: [fakeSession("s1")],
      sessionOverrides: {
        createTerminal: (_session, options = {}) => {
          asked.push(options);

          return Promise.resolve(fakeDescriptor(terminalID()));
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createTerminal",
        id: 1 as RequestID,
        sessionID: "s1" as SessionID,
        placement: { kind: "split", beside, axis: "vertical" },
      }),
    );

    expect((await peer.reply(1 as RequestID)).type).toBe("text");
    expect(asked).toEqual([{ placement: { kind: "split", beside, axis: "vertical" } }]);
  });

  test("an impossible placement is refused, and the brain is not called", async () => {
    const calls: number[] = [];
    const daemon = fixture({
      sessions: [fakeSession("s1")],
      sessionOverrides: {
        createTerminal: () => {
          calls.push(1);

          return Promise.resolve(fakeDescriptor(terminalID()));
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      wireControl({
        type: "createTerminal",
        id: 1,
        sessionID: "s1",
        placement: { kind: "split", beside: terminalID(), axis: "sideways" },
      }),
    );

    expect((await peer.reply(1 as RequestID)).type).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("restartTerminal reaches the brain as one operation", async () => {
    const restarted: TerminalID[] = [];
    const going = terminalID();
    const daemon = fixture({
      sessions: [fakeSession("s1")],
      sessionOverrides: {
        stopTerminal: () => Promise.reject(new Error("stopTerminal must not be called")),
        startTerminal: () => Promise.reject(new Error("startTerminal must not be called")),
        restartTerminal: (id) => {
          restarted.push(id);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(request({ type: "restartTerminal", id: 1 as RequestID, terminalID: going }));

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(restarted).toEqual([going]);
  });

  test("removeTerminal closes one terminal and is acknowledged", async () => {
    const removed: TerminalID[] = [];
    const going = terminalID();
    const daemon = fixture({
      sessions: [fakeSession("s1")],
      sessionOverrides: {
        removeTerminal: (id) => {
          removed.push(id);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(request({ type: "removeTerminal", id: 1 as RequestID, terminalID: going }));

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
    expect(removed).toEqual([going]);
  });
});

describe("integrations", () => {
  const CLAUDE: IntegrationReport = {
    id: "claude",
    name: "Claude Code",
    executable: "claude",
    isAvailable: true,
    configPath: "/Users/ada/.claude/settings.json",
    reports: ["starts working", "waits for permission"],
    status: { kind: "absent" },
  };

  test("the overview round-trips as text", async () => {
    const daemon = fixture({ integrations: fakeIntegrations({ integrations: [CLAUDE] }) });
    const peer = await daemon.connect();

    await peer.send(request({ type: "integrations", id: 1 as RequestID }));
    const reply = await peer.reply(1 as RequestID);

    if (reply.type !== "text") throw new Error(`expected text, got ${reply.type}`);

    expect(parseIntegrationOverview(reply.text)).toEqual({ integrations: [CLAUDE] });
  });

  test("installing and removing name the integration the client asked for", async () => {
    const integrations = fakeIntegrations();
    const daemon = fixture({ integrations });
    const peer = await daemon.connect();

    await peer.send(
      request({ type: "installIntegration", id: 1 as RequestID, integrationID: "codex" }),
    );

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });

    await peer.send(
      request({ type: "removeIntegration", id: 2 as RequestID, integrationID: "omp" }),
    );

    expect(await peer.reply(2 as RequestID)).toEqual({ type: "acknowledged", id: 2 as RequestID });
    expect(integrations.installs).toEqual(["codex"]);
    expect(integrations.removals).toEqual(["omp"]);
  });

  test("an integration nobody ships is refused, and nothing is installed", async () => {
    const integrations = fakeIntegrations();
    const daemon = fixture({ integrations });
    const peer = await daemon.connect();

    await peer.send(
      wireControl({ type: "installIntegration", id: 1, integrationID: "emacs-doctor" }),
    );
    const reply = await peer.reply(1 as RequestID);

    expect(reply.type).toBe("failed");
    expect(integrations.installs).toEqual([]);
  });
});

describe("correlation", () => {
  test("a slow request never delays a fast one, and each reply carries its own id", async () => {
    const slow = Promise.withResolvers<void>();
    const renamed: string[] = [];
    const daemon = fixture({
      sessionOverrides: {
        createSession: async () => {
          await slow.promise;

          return fakeSession("s1");
        },
        rename: (_id, name) => {
          renamed.push(name);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createSession",
        id: 1 as RequestID,
        intent: { kind: "standalone", directory: "/tmp/x" as Session["directory"] },
      }),
    );
    await peer.send(
      request({
        type: "renameSession",
        id: 2 as RequestID,
        sessionID: "s1" as SessionID,
        name: "renamed",
      }),
    );

    expect(await peer.reply(2 as RequestID)).toEqual({ type: "acknowledged", id: 2 as RequestID });
    expect(correlated(peer.controls, 1 as RequestID)).toBeUndefined();
    expect(renamed).toEqual(["renamed"]);

    slow.resolve();

    expect(await peer.reply(1 as RequestID)).toEqual({ type: "acknowledged", id: 1 as RequestID });
  });

  test("an id already in flight is dropped rather than answered twice", async () => {
    const slow = Promise.withResolvers<void>();
    const renamed: string[] = [];
    const daemon = fixture({
      sessionOverrides: {
        createSession: async () => {
          await slow.promise;

          return fakeSession("s1");
        },
        rename: (_id, name) => {
          renamed.push(name);

          return Promise.resolve();
        },
      },
    });
    const peer = await daemon.connect();

    await peer.send(
      request({
        type: "createSession",
        id: 7 as RequestID,
        intent: { kind: "standalone", directory: "/tmp/x" as Session["directory"] },
      }),
    );
    await peer.send(
      request({
        type: "renameSession",
        id: 7 as RequestID,
        sessionID: "s1" as SessionID,
        name: "collision",
      }),
    );
    await until(() => daemon.with("duplicate request id").length === 1, "the duplicate to be seen");

    expect(renamed).toEqual([]);
    expect(correlated(peer.controls, 7 as RequestID)).toBeUndefined();

    slow.resolve();
    await peer.reply(7 as RequestID);

    expect(peer.controls.filter((message) => message.type === "acknowledged")).toHaveLength(1);
  });

  test("a request whose id is unusable gets no reply, and the connection lives", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const peer = await daemon.connect();

    await peer.send(
      wireControl({
        type: "createSession",
        id: "one",
        intent: { kind: "standalone", directory: "/tmp/x" },
      }),
    );
    await until(() => daemon.with("request malformed").length === 1, "the malformed request");

    expect(peer.controls).toHaveLength(1);

    await peer.send(
      request({
        type: "attach",
        id: 3 as RequestID,
        terminalID: terminal.id,
        viewport: { columns: 0, rows: -1 },
      }),
    );

    expect(await peer.reply(3 as RequestID)).toEqual({
      type: "failed",
      id: 3 as RequestID,
      failure: {
        summary: "Couldn't complete the request.",
        recoverySuggestion: "If this keeps happening, please file an issue with the log.",
      },
    });
    expect(terminal.attachCalls).toEqual([]);
  });
});

class UnavailableProfile extends UserFacingError {
  override readonly summary = "That command isn't available.";

  constructor() {
    super("launch profile not on PATH");
  }
}
