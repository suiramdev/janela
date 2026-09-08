import { afterEach, describe, expect, test } from "bun:test";

import type { GridSize, Session, TerminalID } from "@janela/core";
import {
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  decodeDaemonMessage,
  decodeOutput,
  encodeClientMessage,
  encodeInput,
  encodeOutput,
  type DaemonMessage,
  type Frame,
  type MessageTransport,
  type RequestID,
} from "@janela/protocol";

import { FRAME_INTERVAL_MS } from "./frame-loop.ts";
import {
  CONTROL_QUEUE_CAPACITY,
  DAEMON_CLIENT_NAME,
  OUTPUT_QUEUE_CAPACITY,
  createDaemonServer,
  type DaemonServer,
} from "./server.ts";
import {
  clientHello,
  fakeDispatch,
  fakeLaunchProfiles,
  fakeProjects,
  fakeRegistry,
  fakeSession,
  fakeSessions,
  fakeTerminal,
  malformedHello,
  memoryListener,
  recordingLogger,
  type FakeDispatch,
  type FakeRegistry,
  type FakeTerminal,
  type MemoryListener,
  type Recorded,
  type TransportPair,
} from "./test-fakes.ts";

const REQUEST_ID = 1 as RequestID;
const VIEWPORT: GridSize = { columns: 80, rows: 24 };

const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;

/**
 * Waits for a condition rather than a duration.
 *
 * The daemon's own clocks are real — the handshake deadline is a `setTimeout` and
 * the frame loop a `setInterval` — so a test that asserts about them has to let
 * real time pass. Polling the condition keeps a failure pointing at the
 * condition rather than at a guessed sleep.
 */
async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    // Polling is the point: the condition is what the test waits for, and each
    // check has to happen after the previous one.
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

interface TestClient {
  send(frame: Frame): Promise<void>;
  /** Frames the daemon sent, in arrival order. Both kinds. */
  readonly frames: Frame[];
  controls(): DaemonMessage[];
  outputs(): { readonly terminalID: TerminalID; readonly text: string }[];
  /** True once the daemon closed our side. */
  ended(): boolean;
  /**
   * Takes exactly one frame.
   *
   * The transport is a rendezvous: a frame the daemon sent is not delivered until
   * a client takes it, which is what lets a test build a peer that handshakes and
   * then genuinely stops reading.
   */
  receive(): Promise<Frame>;
  /** Starts draining. A client that never does this is a client that stopped reading. */
  read(): void;
  close(): Promise<void>;
}

function testClient(pair: TransportPair): TestClient {
  const transport: MessageTransport = pair.clientSide;
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let iterator: AsyncIterator<Frame> | undefined;
  let finished = false;

  const source = (): AsyncIterator<Frame> => {
    iterator ??= transport.incoming()[Symbol.asyncIterator]();
    return iterator;
  };

  return {
    frames,
    send: (frame) => transport.send(frame),
    controls: () =>
      frames.filter((frame) => frame.kind === FrameKind.Control).map(decodeDaemonMessage),
    outputs: () =>
      frames
        .filter((frame) => frame.kind === FrameKind.Output)
        .map((frame) => {
          const output = decodeOutput(frame);
          return { terminalID: output.terminalID, text: decoder.decode(output.bytes) };
        }),
    ended: () => finished,
    async receive(): Promise<Frame> {
      const next = await source().next();
      if (next.done === true) {
        finished = true;
        throw new Error("the daemon closed the connection");
      }
      frames.push(next.value);
      return next.value;
    },
    read: () => {
      void (async () => {
        try {
          for (;;) {
            // A drain reads frames one at a time, in order.
            // oxlint-disable-next-line no-await-in-loop
            const next = await source().next();
            if (next.done === true) return;
            frames.push(next.value);
          }
        } finally {
          finished = true;
        }
      })();
    },
    close: () => transport.close(),
  };
}

interface Fixture {
  readonly server: DaemonServer;
  readonly listener: MemoryListener;
  readonly registry: FakeRegistry;
  readonly dispatch: FakeDispatch;
  readonly records: Recorded[];
  /** Records with this message, in order. */
  with(message: string): Recorded[];
  /** Connects, handshakes, and returns a reading client. */
  connect(hello?: Frame): Promise<TestClient>;
  /** Connects without handshaking. */
  open(): TestClient;
  readonly serving: Promise<void>;
  stop(): Promise<void>;
}

const running: Fixture[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((active) => active.stop()));
});

function fixture(
  options: {
    readonly terminals?: readonly FakeTerminal[];
    /** Sessions the daemon enumerates terminals through, for the per-frame drain. */
    readonly sessions?: readonly Session[];
  } = {},
): Fixture {
  const registry = fakeRegistry(options.terminals ?? []);
  const dispatch = fakeDispatch(registry);
  const { logger, records, with: withMessage } = recordingLogger();
  const listener = memoryListener();
  const controller = new AbortController();

  const server = createDaemonServer({
    sessions: fakeSessions(options.sessions ?? []),
    projects: fakeProjects(),
    launchProfiles: fakeLaunchProfiles(),
    terminals: registry,
    log: logger,
    dispatch,
    // Short, because four tests are about what happens when it expires.
    handshakeDeadlineMs: 25,
  });

  const serving = server.serve(listener, controller.signal);

  const value: Fixture = {
    server,
    listener,
    registry,
    dispatch,
    records,
    with: withMessage,
    serving,
    open: () => testClient(listener.connect()),
    async connect(hello = clientHello()): Promise<TestClient> {
      const client = testClient(listener.connect());
      client.read();
      await client.send(hello);
      await until(() => client.controls().length > 0, "the daemon's hello");
      return client;
    },
    async stop(): Promise<void> {
      controller.abort();
      await serving;
    },
  };

  running.push(value);
  return value;
}

const subscribeToState = (id: RequestID = REQUEST_ID): Frame =>
  encodeClientMessage({ type: "subscribe", id, scope: { kind: "state" } });

describe("the handshake", () => {
  test("a compatible peer is answered with the daemon's own range", async () => {
    const daemon = fixture();

    const client = await daemon.connect();

    expect(client.controls()).toEqual([
      {
        type: "hello",
        hello: {
          protocolVersion: PROTOCOL_VERSION,
          minimumSupported: MINIMUM_SUPPORTED_VERSION,
          clientName: DAEMON_CLIENT_NAME,
        },
      },
    ]);
    expect(daemon.server.connectionCount).toBe(1);
    expect(daemon.with("client connected")[0]?.fields?.["uid"]).toBe(501);

    await client.close();
    await until(() => daemon.server.connectionCount === 0, "the connection to be released");
    expect(daemon.with("client disconnected")).toHaveLength(1);
  });

  test("version skew is refused without touching a terminal, and the daemon keeps serving", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const liveBefore = daemon.registry.liveCount;

    const client = testClient(daemon.listener.connect());
    client.read();
    await client.send(clientHello({ protocolVersion: 1, minimumSupported: 1 }));
    await until(() => client.controls().length > 0, "the refusal");

    expect(client.controls()[0]).toEqual({
      type: "refused",
      refusal: { kind: "incompatibleVersion", daemonMinimum: 3, daemonCurrent: 3 },
    });
    await until(() => client.ended(), "the connection to close");

    expect(terminal.stopCalls.count).toBe(0);
    expect(daemon.registry.hangUpAllCalls.count).toBe(0);
    expect(daemon.registry.liveCount).toBe(liveBefore);
    expect(daemon.server.connectionCount).toBe(0);

    // The whole point of a refusal: the next client is served.
    await daemon.connect();
    expect(daemon.server.connectionCount).toBe(1);
  });

  test("anything other than a valid hello first is a protocol violation", async () => {
    const daemon = fixture();

    const early = testClient(daemon.listener.connect());
    early.read();
    await early.send(subscribeToState());
    await until(() => early.controls().length > 0, "the refusal");
    expect(early.controls()[0]).toEqual({
      type: "refused",
      refusal: { kind: "protocolViolation" },
    });

    const wrongType = testClient(daemon.listener.connect());
    wrongType.read();
    await wrongType.send(
      malformedHello({ protocolVersion: "2", minimumSupported: 2, clientName: "test" }),
    );
    await until(() => wrongType.controls().length > 0, "the refusal");
    expect(wrongType.controls()[0]).toEqual({
      type: "refused",
      refusal: { kind: "protocolViolation" },
    });

    expect(daemon.server.connectionCount).toBe(0);
  });

  test("a second hello on an established connection is refused and closes it", async () => {
    const daemon = fixture();
    const client = await daemon.connect();

    await client.send(clientHello());
    await until(() => client.ended(), "the connection to close");

    expect(client.controls()[1]).toEqual({
      type: "refused",
      refusal: { kind: "protocolViolation" },
    });
    expect(daemon.server.connectionCount).toBe(0);
  });

  test("a peer that never says hello is closed by the deadline, and the daemon accepts after", async () => {
    const daemon = fixture();

    const silent = daemon.open();
    silent.read();

    await until(() => daemon.with("handshake timed out").length === 1, "the deadline");
    expect(silent.ended()).toBe(true);
    expect(daemon.server.connectionCount).toBe(0);

    await daemon.connect();
    expect(daemon.server.connectionCount).toBe(1);
  });
});

describe("connection failures", () => {
  test("a malformed control frame closes that connection and no other", async () => {
    const daemon = fixture();
    const healthy = await daemon.connect();
    await healthy.send(subscribeToState());
    await until(() => daemon.dispatch.requests.length === 1, "the subscription");

    const broken = await daemon.connect();
    await broken.send({ kind: FrameKind.Control, payload: new TextEncoder().encode("{") });
    await until(() => broken.ended(), "the broken connection to close");

    expect(daemon.with("connection failed")[0]?.fields?.["error"]).toBe("malformedControl");
    expect(daemon.server.connectionCount).toBe(1);

    await daemon.server.sessionsChanged([fakeSession("s1")]);
    await until(
      () => healthy.controls().some((message) => message.type === "state"),
      "the surviving client's state update",
    );
  });

  test("an input frame naming an unknown terminal closes the connection and creates nothing", async () => {
    const daemon = fixture();
    const client = await daemon.connect();
    const unknown = terminalID();

    await client.send(encodeInput({ terminalID: unknown, bytes: new TextEncoder().encode("x") }));
    await until(() => client.ended(), "the connection to close");

    const failure = daemon.with("connection failed")[0];
    expect(failure?.fields?.["error"]).toBe("unknownTerminal");
    expect(failure?.fields?.["terminalID"]).toBe(unknown);
    expect(daemon.registry.registerCalls.count).toBe(0);
    expect(daemon.dispatch.inputs).toEqual([]);
  });

  test("a client sending an output frame is a direction violation", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const client = await daemon.connect();

    await client.send(encodeOutput({ terminalID: terminal.id, bytes: new Uint8Array([1]) }));
    await until(() => client.ended(), "the connection to close");

    expect(daemon.with("connection failed")[0]?.fields?.["error"]).toBe("unexpectedKind");
  });

  test("input reaches the dispatcher, and a throwing dispatcher costs a log line, not the connection", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const client = await daemon.connect();

    await client.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("ls") }),
    );
    await until(() => daemon.dispatch.inputs.length === 1, "the input");
    expect(daemon.dispatch.inputs[0]).toEqual({
      client: "c1",
      terminalID: terminal.id,
      text: "ls",
    });

    daemon.dispatch.failure = new RangeError("pty gone");
    await client.send(
      encodeInput({ terminalID: terminal.id, bytes: new TextEncoder().encode("x") }),
    );
    await until(() => daemon.with("input failed").length === 1, "the failure record");

    daemon.dispatch.failure = undefined;
    await client.send(subscribeToState());
    await until(
      () => client.controls().some((message) => message.type === "acknowledged"),
      "the connection to still answer",
    );
    expect(client.ended()).toBe(false);
  });
});

describe("fan-out", () => {
  test("only state subscribers hear about sessions", async () => {
    const daemon = fixture();
    const subscriber = await daemon.connect();
    const terminalScoped = await daemon.connect();
    const silent = await daemon.connect();

    await subscriber.send(subscribeToState());
    await terminalScoped.send(
      encodeClientMessage({
        type: "subscribe",
        id: REQUEST_ID,
        scope: { kind: "terminal", terminalID: terminalID() },
      }),
    );
    await until(() => daemon.dispatch.requests.length === 2, "both subscriptions");

    const session = fakeSession("s1");
    await daemon.server.sessionsChanged([session]);
    await until(
      () => subscriber.controls().some((message) => message.type === "state"),
      "the state update",
    );

    const update = subscriber.controls().find((message) => message.type === "state");
    expect(update).toEqual({
      type: "state",
      update: {
        projects: [],
        sessions: [session],
        terminalStates: {},
        launchProfiles: [],
        launchProfileAvailability: {},
        isFullSnapshot: true,
      },
    });
    expect(terminalScoped.controls().some((message) => message.type === "state")).toBe(false);
    expect(silent.controls()).toHaveLength(1);
  });

  test("publish never waits on a client, and the one that stopped reading is the only casualty", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });

    const reading = await daemon.connect();
    await reading.send(subscribeToState());

    // Handshakes, subscribes, takes both replies, and then stops taking frames.
    // It stays connected: the frames it is sent pile up in its own control queue
    // and nowhere else.
    const stalled = testClient(daemon.listener.connect());
    await stalled.send(clientHello());
    await stalled.receive();
    await stalled.send(subscribeToState());
    await stalled.receive();
    await until(() => daemon.dispatch.requests.length === 2, "both subscriptions");

    const publishes: Promise<void>[] = [];
    const started = Bun.nanoseconds();
    for (let index = 0; index < CONTROL_QUEUE_CAPACITY + 2; index += 1) {
      publishes.push(daemon.server.sessionsChanged([fakeSession(`s${index}`)]));
      // A yield, not a wait: it lets the *reading* client's pump take a frame.
      // The stalled client's pump cannot, which is the difference under test.
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }
    // Every publish settled, with a subscriber that has read nothing since its
    // handshake. The daemon never waited on it.
    await Promise.all(publishes);
    expect(Bun.nanoseconds() - started).toBeLessThan(2_000_000_000);

    await until(() => daemon.with("client stalled").length === 1, "the stall to be noticed");
    expect(daemon.with("client stalled")[0]?.fields?.["queued"]).toBe(CONTROL_QUEUE_CAPACITY);
    expect(daemon.server.connectionCount).toBe(1);

    await until(
      () =>
        reading.controls().filter((message) => message.type === "state").length ===
        CONTROL_QUEUE_CAPACITY + 2,
      "the reading client to receive every update",
    );
    const names = reading
      .controls()
      .filter((message) => message.type === "state")
      .map((message) => (message.type === "state" ? message.update.sessions[0]?.name : undefined));
    expect(names).toEqual(
      Array.from({ length: CONTROL_QUEUE_CAPACITY + 2 }, (_unused, index) => `s${index}`),
    );

    expect(terminal.stopCalls.count).toBe(0);
    expect(daemon.registry.hangUpAllCalls.count).toBe(0);
  });
});

describe("attachment and output", () => {
  test("an attached client gets a full repaint first, then deltas, and nothing after detach", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const client = await daemon.connect();

    await client.send(
      encodeClientMessage({
        type: "attach",
        id: REQUEST_ID,
        terminalID: terminal.id,
        viewport: VIEWPORT,
      }),
    );
    await until(() => terminal.attached.size === 1, "the viewport to register");
    expect(terminal.attached.get("c1")).toEqual(VIEWPORT);

    // The loop is running on its own interval — `serve` started it — so counts are
    // asserted as "at least" and the *order* is what matters: the full repaint
    // comes first, and everything after it is a delta.
    await until(() => client.outputs().length >= 2, "the full repaint and a delta");
    const received = client.outputs();
    expect(received[0]).toEqual({ terminalID: terminal.id, text: "F" });
    expect(received.slice(1).every((output) => output.text === "d")).toBe(true);
    expect(terminal.fullRepaintCalls).toEqual(["c1"]);

    await client.send(
      encodeClientMessage({ type: "detach", id: REQUEST_ID, terminalID: terminal.id }),
    );
    await until(() => terminal.attached.size === 0, "the detach");
    const afterDetach = client.outputs().length;
    for (let index = 0; index < 4; index += 1) {
      daemon.server.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }
    expect(client.outputs()).toHaveLength(afterDetach);
  });

  test("closing a connection detaches its viewports and never stops the terminal", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const client = await daemon.connect();

    await client.send(
      encodeClientMessage({
        type: "attach",
        id: REQUEST_ID,
        terminalID: terminal.id,
        viewport: VIEWPORT,
      }),
    );
    await until(() => terminal.attached.size === 1, "the viewport to register");

    await client.close();
    await until(() => daemon.server.connectionCount === 0, "the connection to be released");

    expect(terminal.attached.size).toBe(0);
    expect(terminal.stopCalls.count).toBe(0);
  });

  test("a client that stops reading output stops costing encodes, and recovers with a full repaint", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });

    // Handshakes and attaches by hand, taking exactly the two replies it is owed,
    // and then stops taking frames while staying connected.
    const client = testClient(daemon.listener.connect());
    await client.send(clientHello());
    await client.receive();
    await client.send(
      encodeClientMessage({
        type: "attach",
        id: REQUEST_ID,
        terminalID: terminal.id,
        viewport: VIEWPORT,
      }),
    );
    await client.receive();
    await until(() => terminal.attached.size === 1, "the viewport to register");

    const taken = client.frames.length;
    for (let index = 0; index < OUTPUT_QUEUE_CAPACITY + 10; index += 1) {
      daemon.server.frameLoop.tick();
      // Lets the output pump take what it can, so the bound is reached rather
      // than raced past.
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    const encodes = terminal.repaintCalls.length + terminal.fullRepaintCalls.length;
    // One frame in the pump's hand, the queue full, and no encode after that —
    // however many times the loop runs.
    expect(encodes).toBeLessThanOrEqual(OUTPUT_QUEUE_CAPACITY + 2);
    expect(client.frames.length).toBe(taken);

    for (let index = 0; index < 5; index += 1) {
      daemon.server.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }
    expect(terminal.repaintCalls.length + terminal.fullRepaintCalls.length).toBe(encodes);

    // Reading again drains the backlog, and the frame after it is a full repaint —
    // the only reason dropping a delta was safe. The loop is also running on its
    // own interval, so the assertion is about order and count of full repaints,
    // not about which tick delivered what.
    client.read();
    await until(
      () => client.outputs().filter((output) => output.text === "F").length === 2,
      "the recovery repaint",
    );

    const outputs = client.outputs();
    expect(outputs[0]?.text).toBe("F");
    const recovery = outputs.findLastIndex((output) => output.text === "F");
    expect(recovery).toBeGreaterThan(1);
    expect(outputs.slice(1, recovery).every((output) => output.text === "d")).toBe(true);
    expect(terminal.fullRepaintCalls).toEqual(["c1", "c1"]);
  });

  test("a dead client attached to a terminal costs the other client nothing", async () => {
    const terminal = fakeTerminal(terminalID());
    const daemon = fixture({ terminals: [terminal] });
    const attach = encodeClientMessage({
      type: "attach",
      id: REQUEST_ID,
      terminalID: terminal.id,
      viewport: VIEWPORT,
    });

    const alive = await daemon.connect();
    await alive.send(attach);

    // Handshakes, attaches, and then never takes another frame.
    const dead = testClient(daemon.listener.connect());
    await dead.send(clientHello());
    await dead.receive();
    await dead.send(attach);
    await dead.receive();
    const deadTook = dead.frames.length;
    await until(() => terminal.attached.size === 2, "both viewports");

    const frames = 40;
    for (let index = 0; index < frames; index += 1) {
      daemon.server.frameLoop.tick();
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(0);
    }

    await until(() => alive.outputs().length >= frames, "every frame for the live client");
    expect(dead.outputs()).toHaveLength(0);
    expect(dead.frames.length).toBe(deadTook);
    // The live client's encodes keep coming; the dead one's stop at its bound.
    expect(terminal.repaintCalls.filter((client) => client === "c1").length).toBeGreaterThanOrEqual(
      frames - 1,
    );
    expect(terminal.repaintCalls.filter((client) => client === "c2").length).toBeLessThanOrEqual(
      OUTPUT_QUEUE_CAPACITY + 2,
    );
    // Output overflow drops frames; it does not disconnect and it does not stop a
    // terminal. Only an unread *control* queue costs a peer its connection.
    expect(daemon.server.connectionCount).toBe(2);
    expect(terminal.stopCalls.count).toBe(0);
  });

  test("a terminal nobody is watching is still drained, on the daemon's own frame", async () => {
    const terminal = fakeTerminal(terminalID());
    // The daemon reaches its terminals through the sessions, because the registry
    // has no iterator. No client ever connects in this test.
    const daemon = fixture({ terminals: [terminal], sessions: [fakeSession("session")] });

    await until(() => terminal.drainCalls.count > 1, "the unwatched terminal to be fed");
    expect(daemon.server.connectionCount).toBe(0);
    expect(terminal.repaintCalls).toEqual([]);
    expect(terminal.stopCalls.count).toBe(0);
  });
});

describe("lifecycle", () => {
  test("the daemon may exit only with no live terminal and no client", async () => {
    const idle = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const live = fakeTerminal(terminalID());

    const withLive = fixture({ terminals: [live] });
    expect(withLive.server.canExitWhenIdle()).toBe(false);

    const withIdle = fixture({ terminals: [idle] });
    expect(withIdle.server.canExitWhenIdle()).toBe(true);
    await withIdle.connect();
    expect(withIdle.server.canExitWhenIdle()).toBe(false);
  });

  test("aborting resolves serve, closes the listener, and ends every client", async () => {
    const daemon = fixture();
    const first = await daemon.connect();
    const second = await daemon.connect();

    await daemon.stop();

    expect(daemon.listener.closeCalls.count).toBeGreaterThan(0);
    await until(() => first.ended() && second.ended(), "both clients to see the close");
    expect(daemon.server.connectionCount).toBe(0);
    expect(daemon.with("daemon stopping")).toHaveLength(2);
  });

  test("a terminal that starts after the loop went to sleep is still fed", async () => {
    const terminal = fakeTerminal(terminalID());
    // The session appears when the terminal does, which is the order the session
    // layer creates them in.
    const sessions: Session[] = [];
    const daemon = fixture({ sessions });

    // Nothing live and nobody attached: the loop drops its timer after one frame.
    await Bun.sleep(FRAME_INTERVAL_MS * 8);
    daemon.registry.add(terminal);
    sessions.push(fakeSession("session"));
    await Bun.sleep(FRAME_INTERVAL_MS * 8);
    expect(terminal.drainCalls.count).toBe(0);

    // A state change is how automation-started terminals reach the daemon.
    await daemon.server.projectsChanged([]);
    await until(() => terminal.drainCalls.count > 1, "the woken loop to feed it");
  });
});
