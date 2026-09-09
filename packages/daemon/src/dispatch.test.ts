import { afterEach, describe, expect, test } from "bun:test";

import type {
  GridSize,
  LaunchProfile,
  LaunchProfileID,
  Project,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
} from "@janela/core";
import {
  FrameKind,
  decodeDaemonMessage,
  encodeClientMessage,
  encodeInput,
  parseRemovalPlan,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type RequestID,
  type SessionRemovalPreview,
} from "@janela/protocol";
import type {
  LaunchProfileService,
  NewTerminalOptions,
  ProjectService,
  SessionRemovalPlan,
  SessionService,
} from "@janela/session";
import { UserFacingError } from "@janela/support";

import { createDaemonServer, type DaemonServer } from "./server.ts";
import {
  clientHello,
  fakeLaunchProfiles,
  fakeProfile,
  fakeProjects,
  fakeRegistry,
  fakeSession,
  fakeSessions,
  fakeTerminal,
  memoryListener,
  recordingLogger,
  type FakeRegistry,
  type FakeTerminal,
  type Recorded,
} from "./test-fakes.ts";

const VIEWPORT: GridSize = { columns: 80, rows: 24 };
const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;

/** Marker text a person must never see: it stands in for a page of git stderr. */
const STDERR = "fatal: could not read Username for https://example.invalid";

class GitFailure extends UserFacingError {
  override readonly summary = "Couldn't create the session.";
}

/** Stands in for `@janela/session`'s `BuiltInProfileProtected`, which is its own test's. */
class BuiltInProfile extends UserFacingError {
  override readonly summary = "Built-in profiles can't be deleted.";

  constructor() {
    super("built-in launch profile cannot be removed", {
      recoverySuggestion: "Edit it instead, or copy it and edit the copy.",
    });
  }
}

/** What `createTerminal` hands back: only the fields the dispatcher reads. */
function fakeDescriptor(id: TerminalID): TerminalDescriptor {
  return {
    id,
    title: "Shell",
    startsAutomatically: true,
    role: { kind: "user" },
    createdAt: "2026-01-01T00:00:00.000Z" as TerminalDescriptor["createdAt"],
  };
}

/**
 * Waits for a condition rather than a duration.
 *
 * The server runs a real frame interval and answers requests off the read loop,
 * so a test has to let real time pass; polling keeps a failure pointing at the
 * condition rather than at a guessed sleep.
 */
async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    // Polling is the point: each check happens after the previous one.
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

interface Peer {
  send(frame: Frame): Promise<void>;
  /** Everything the daemon said on the control channel, in order. */
  readonly controls: DaemonMessage[];
  /** The reply correlated to this request, once it arrives. */
  reply(id: RequestID): Promise<DaemonMessage>;
  /** Raw frames, for the "did this client get a repaint" question. */
  readonly frames: Frame[];
  /** Takes exactly one frame. For a peer that is not draining. */
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

const running: Fixture[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((active) => active.stop()));
});

/** A server with the *real* dispatcher: no `dispatch` override, on purpose. */
function fixture(
  options: {
    readonly terminals?: readonly FakeTerminal[];
    readonly sessions?: readonly Session[];
    readonly projects?: readonly Project[];
    readonly sessionOverrides?: Partial<SessionService>;
    readonly projectOverrides?: Partial<ProjectService>;
    readonly profiles?: readonly LaunchProfile[];
    readonly profileOverrides?: Partial<LaunchProfileService>;
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
    terminals: registry,
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
      // A peer that does not drain is how the output queue is made to overflow:
      // the transport is a rendezvous, so an untaken frame stays in the daemon.
      const drains = connectOptions.drains ?? true;
      if (drains) {
        void (async () => {
          for (;;) {
            // One frame at a time, in order, for as long as the daemon lives.
            // oxlint-disable-next-line no-await-in-loop
            await take();
          }
        })().catch(() => {
          // The daemon closing is how every one of these ends.
        });
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

/** The reply to one request, which is the only place a `RequestID` may appear. */
function correlated(controls: readonly DaemonMessage[], id: RequestID): DaemonMessage | undefined {
  return controls.find(
    (message) =>
      (message.type === "acknowledged" || message.type === "failed" || message.type === "text") &&
      message.id === id,
  );
}

const request = (message: ClientMessage): Frame => encodeClientMessage(message);

/** Every byte the daemon sent this peer, and every field it logged, as one string. */
function everythingSaid(peer: Peer, records: readonly Recorded[]): string {
  const decoder = new TextDecoder();
  return [
    ...peer.frames.map((frame) => decoder.decode(frame.payload)),
    JSON.stringify(records),
  ].join("\n");
}

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
    // The terminal never learned about it: no viewport, no size negotiation, and
    // nothing for the frame loop to encode.
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

    // Participation is per client, not per terminal.
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

    // Dropping the input is not a reason to lose the connection.
    await stranger.send(request({ type: "detach", id: 9 as RequestID, terminalID: terminal.id }));
    expect(await stranger.reply(9 as RequestID)).toEqual({
      type: "acknowledged",
      id: 9 as RequestID,
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
      // Lets the pump hand the frame over, so the next tick is a fresh one.
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    // A repaint for a client the terminal never attached is not a wasted encode,
    // it is an exception: `LiveTerminal.repaintFor` throws for an unknown client,
    // and the loop answers that by dropping the terminal.
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
    // Ordered on one queue: the mirror is populated by the time `request()` settles.
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
    // Each removal used the plan fetched for it, never one the client was holding.
    expect(removals[0]?.plan).toBe(plans[0]);
    expect(removals[1]?.plan).toBe(plans[1]);
    expect(plans).toHaveLength(2);
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
    // Profiles have no `StateObserving` path: without the dispatcher announcing,
    // a settings window would show a profile no other client can see.
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
      encodeClientMessage({
        type: "saveLaunchProfile",
        id: 1 as RequestID,
        // argv with a hole in it: the wire has no type system, and this reaches
        // `execve` if nobody looks.
        profile: { ...fakeProfile("p1"), command: ["zsh", null] },
      } as unknown as ClientMessage),
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

    // The id comes back because the client needs it to attach; the process does
    // not exist yet, and `startTerminal` is still the only thing that spawns one.
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
      encodeClientMessage({
        type: "createTerminal",
        id: 1 as RequestID,
        sessionID: "s1" as SessionID,
        // An axis the layout algebra has never heard of: the wire has no type
        // system, and this reaches `splitPane` if nobody looks.
        placement: { kind: "split", beside: terminalID(), axis: "sideways" },
      } as unknown as ClientMessage),
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
        // Neither of these may be reached: a stop and a start over the wire is
        // exactly the ordering this message exists to avoid.
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

describe("correlation", () => {
  test("a slow request never delays a fast one, and each reply carries its own id", async () => {
    // Held open by hand: the point is that a request in flight blocks nothing else.
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
    // Held open by hand: the point is that a request in flight blocks nothing else.
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

    // The colliding request did not run: answering it would have settled the
    // client's promise for the createSession that is still in flight.
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
      encodeClientMessage({
        type: "createSession",
        id: "one",
        intent: { kind: "standalone", directory: "/tmp/x" },
      } as unknown as ClientMessage),
    );
    await until(() => daemon.with("request malformed").length === 1, "the malformed request");
    expect(peer.controls).toHaveLength(1);

    // A bad *field* is answerable, unlike a bad id, so it is answered.
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
