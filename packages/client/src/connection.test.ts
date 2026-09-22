import { afterEach, describe, expect, test } from "bun:test";

import { instant, type SessionID } from "@janela/core";
import {
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  RAW_HEADER_LENGTH,
  encodeFrame,
  type RequestID,
} from "@janela/protocol";

import {
  ConnectionUnavailable,
  RECONNECT_MAXIMUM_DELAY_MS,
  RequestFailed,
  createConnection,
  reconnectDelay,
  type DaemonConnection,
} from "./connection.ts";
import {
  createStores,
  type MirrorApplying,
  type ProjectStore,
  type SessionStore,
} from "./stores.ts";
import {
  daemonHello,
  fakeDaemon,
  fakeDelay,
  fakeProject,
  fakeSession,
  fixtureID,
  partial,
  recordingLogger,
  snapshot,
  stateMessage,
  terminalID,
  until,
  type FakeConnection,
  type FakeDaemon,
  type FakeDelay,
  type RecordingLogger,
} from "./test-fakes.ts";

interface Harness {
  readonly daemon: FakeDaemon;
  readonly connection: DaemonConnection;
  readonly delays: FakeDelay;
  readonly logger: RecordingLogger;
  readonly sessions: SessionStore;
  readonly projects: ProjectStore;
  readonly mirror: MirrorApplying;
  handshake(index: number | undefined): Promise<FakeConnection>;
}

const id = (name: string): SessionID => name as SessionID;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function harness(options: { readonly handshakeDeadlineMs?: number } = {}): Harness {
  const daemon = fakeDaemon();
  const stores = createStores();
  const delays = fakeDelay();
  const logger = recordingLogger();

  const connection = createConnection({
    openTransport: daemon.openTransport,
    clientName: "test",
    mirror: stores.mirror,
    log: logger.log,
    delay: delays.delay,
    ...options,
  });

  live = connection;

  return {
    daemon,
    connection,
    delays,
    logger,
    sessions: stores.sessions,
    projects: stores.projects,
    mirror: stores.mirror,

    async handshake(index = 0): Promise<FakeConnection> {
      void connection.connect();
      await until(() => daemon.connections.length > index, `connection ${index}`);
      const peer = daemon.connections[index];

      if (peer === undefined) throw new Error(`no connection ${index}`);

      await until(() => peer.controls().length > 0, "the client's hello");
      peer.say(daemonHello());
      await until(() => connection.status.kind === "connected", "connected");
      await until(() => peer.controls().length > 1, "the subscribe");

      return peer;
    },
  };
}

let live: DaemonConnection | undefined;

afterEach(async () => {
  await live?.disconnect();
  live = undefined;
});

describe("the handshake", () => {
  test("sends hello, waits for the daemon's, then subscribes to state", async () => {
    const { daemon, connection, sessions, logger } = harness();

    const started = connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");

    expect(peer.controls()[0]).toEqual({
      type: "hello",
      hello: {
        protocolVersion: PROTOCOL_VERSION,
        minimumSupported: MINIMUM_SUPPORTED_VERSION,
        clientName: "test",
      },
    });

    expect(peer.controls()).toHaveLength(1);
    expect(connection.status.kind).toBe("connecting");

    peer.say(daemonHello());
    await until(() => peer.controls().length > 1, "the subscribe");

    expect(peer.controls()[1]).toEqual({
      type: "subscribe",
      id: 1 as RequestID,
      scope: { kind: "state" },
    });

    expect(connection.status.kind).toBe("connected");

    await started;

    peer.say({ type: "acknowledged", id: 1 as RequestID });
    peer.say(stateMessage(snapshot([fakeSession("s1")], [fakeProject("p")])));
    await until(() => sessions.sessions.length === 1, "the snapshot");

    expect(sessions.sessions.map((session) => session.id)).toEqual([id("s1")]);
    expect(connection.isStale).toBe(false);
    expect(logger.with("connected")[0]?.fields).toEqual({ clientName: "janelad" });
  });

  test("a refusal is terminal: no retry, no second connection", async () => {
    const { daemon, connection, delays } = harness();

    void connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");

    peer.say({
      type: "refused",
      refusal: { kind: "incompatibleVersion", daemonMinimum: 2, daemonCurrent: 3 },
    });

    await until(() => connection.status.kind === "refused", "the refusal");

    expect(connection.status).toEqual({
      kind: "refused",
      refusal: { kind: "incompatibleVersion", daemonMinimum: 2, daemonCurrent: 3 },
    });

    await Bun.sleep(5);

    expect(daemon.connections).toHaveLength(1);
    expect(delays.calls).toEqual([]);
    expect(peer.closed).toBe(true);
  });

  test("an unauthorized refusal is terminal too", async () => {
    const { daemon, connection, delays } = harness();

    void connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");

    peer.say({ type: "refused", refusal: { kind: "unauthorized" } });
    await until(() => connection.status.kind === "refused", "the refusal");

    await Bun.sleep(5);

    expect(connection.status).toEqual({ kind: "refused", refusal: { kind: "unauthorized" } });
    expect(daemon.connections).toHaveLength(1);
    expect(delays.calls).toEqual([]);
  });

  test("a daemon we cannot speak to is refused by us, in the daemon's own terms", async () => {
    const { daemon, connection, logger } = harness();

    void connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");

    const newer = PROTOCOL_VERSION + 1;
    peer.say(daemonHello({ protocolVersion: newer, minimumSupported: newer }));
    await until(() => connection.status.kind === "refused", "the refusal");

    expect(connection.status).toEqual({
      kind: "refused",
      refusal: { kind: "incompatibleVersion", daemonMinimum: newer, daemonCurrent: newer },
    });

    await Bun.sleep(5);

    expect(daemon.connections).toHaveLength(1);
    expect(logger.with("daemon version incompatible")[0]?.fields).toEqual({
      daemonMinimum: newer,
      daemonCurrent: newer,
    });
  });

  test("a daemon that says something other than hello first is a failed attempt", async () => {
    const { daemon, connection, logger } = harness();

    void connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");

    peer.say({ type: "acknowledged", id: 7 as RequestID });
    await until(() => daemon.connections.length === 2, "a second attempt");

    expect(logger.with("unexpected first message")[0]?.fields).toEqual({ type: "acknowledged" });
  });

  test("the deadline is disarmed once the daemon answers", async () => {
    const { connection, handshake, logger } = harness({ handshakeDeadlineMs: 30 });
    const peer = await handshake(undefined);

    await Bun.sleep(80);

    expect(connection.status.kind).toBe("connected");
    expect(peer.closed).toBe(false);
    expect(logger.with("handshake timed out")).toEqual([]);
  });
});

describe("reconnecting", () => {
  test("backs off 250, 500, 1000 and resets the count once connected", async () => {
    const { daemon, connection, delays } = harness();
    daemon.refuseOpens = 3;
    const seen: string[] = [];
    connection.subscribe(() => {
      const status = connection.status;
      seen.push(status.kind === "reconnecting" ? `reconnecting:${status.attempt}` : status.kind);
    });

    await connection.connect();
    await until(() => daemon.connections.length === 1, "the fourth attempt to be served");

    expect(delays.calls).toEqual([250, 500, 1000]);
    expect(seen).toContain("reconnecting:1");
    expect(seen).toContain("reconnecting:2");
    expect(seen).toContain("reconnecting:3");

    const peer = daemon.connections[0];

    if (peer === undefined) throw new Error("no connection");

    await until(() => peer.controls().length > 0, "the hello");
    peer.say(daemonHello());
    await until(() => connection.status.kind === "connected", "connected");

    peer.end();
    await until(() => connection.status.kind === "reconnecting", "the reconnect");

    expect(connection.status).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  test("a daemon that accepts and says nothing is a failed attempt, retried under backoff — never a refusal", async () => {
    const { daemon, connection, delays, logger } = harness({ handshakeDeadlineMs: 50 });
    const seen: string[] = [];
    connection.subscribe(() => seen.push(connection.status.kind));

    void connection.connect();
    await until(() => daemon.connections.length === 2, "a second attempt");

    expect(delays.calls).toEqual([250]);
    expect(daemon.connections[0]?.closed).toBe(true);
    expect(logger.with("handshake timed out")[0]?.fields).toEqual({ attempt: 0 });
    expect(seen).toContain("reconnecting");
    expect(seen).not.toContain("refused");

    const second = daemon.connections[1];

    if (second === undefined) throw new Error("no second connection");

    await until(() => second.controls().length > 0, "the second hello");
    second.say(daemonHello());
    await until(() => connection.status.kind === "connected", "connected");
  });

  test("the backoff is capped", () => {
    expect(reconnectDelay(1)).toBe(250);
    expect(reconnectDelay(2)).toBe(500);
    expect(reconnectDelay(7)).toBe(RECONNECT_MAXIMUM_DELAY_MS);
    expect(reconnectDelay(20)).toBe(RECONNECT_MAXIMUM_DELAY_MS);
  });

  test("a clean EOF reconnects and re-subscribes", async () => {
    const { daemon, handshake } = harness();
    const first = await handshake(undefined);

    first.end();
    await until(() => daemon.connections.length === 2, "a second connection");
    const second = daemon.connections[1];

    if (second === undefined) throw new Error("no second connection");

    await until(() => second.controls().length > 0, "the second hello");

    expect(second.controls()[0]).toMatchObject({ type: "hello" });

    second.say(daemonHello());
    await until(() => second.controls().length > 1, "the second subscribe");

    expect(second.controls()[1]).toMatchObject({ type: "subscribe", scope: { kind: "state" } });
  });

  test("a daemon killed mid-frame cannot corrupt the connection that replaces it", async () => {
    const { connection, handshake, sessions, logger } = harness();
    const first = await handshake(undefined);

    first.say(stateMessage(snapshot([fakeSession("s1"), fakeSession("s2")])));
    await until(() => sessions.sessions.length === 2, "the first snapshot");
    sessions.selection = id("s1");

    const rejection = connection
      .request({ type: "renameSession", sessionID: id("s1"), name: "renamed" })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    const remainder = first.pushHalf(
      stateMessage(partial([{ ...fakeSession("s2"), name: "half" }])),
    );

    first.end();
    await until(() => connection.status.kind === "reconnecting", "the reconnect");

    expect(await rejection).toBeInstanceOf(ConnectionUnavailable);
    expect(connection.isStale).toBe(true);
    expect(sessions.sessions.map((session) => session.id)).toEqual([id("s1"), id("s2")]);
    expect(sessions.sessions[1]?.name).toBe("s2");
    expect(logger.with("connection lost")[0]?.fields).toEqual({ error: "truncated" });

    const second = await handshake(1);
    second.say(stateMessage(snapshot([fakeSession("s2"), fakeSession("s3")])));
    await until(
      () => sessions.sessions.some((session) => session.id === id("s3")),
      "the second snapshot",
    );

    expect(sessions.sessions.map((session) => session.id)).toEqual([id("s2"), id("s3")]);
    expect(sessions.selection).toBe(id("s2"));
    expect(connection.isStale).toBe(false);

    first.push(remainder);
    first.say(stateMessage(partial([fakeSession("s1")])));
    await Bun.sleep(5);

    expect(sessions.sessions.map((session) => session.id)).toEqual([id("s2"), id("s3")]);
    expect(connection.status.kind).toBe("connected");
  });

  test("a frame from a torn-down connection never reaches the mirror", async () => {
    const { daemon, connection, handshake, sessions } = harness();
    const first = await handshake(undefined);
    first.keepsDeliveringAfterClose = true;

    first.say(stateMessage(snapshot([fakeSession("s1")])));
    await until(() => sessions.sessions.length === 1, "the snapshot");

    const stopped = connection.disconnect();
    first.say(stateMessage(partial([fakeSession("s2")])));
    await Bun.sleep(2);

    expect(sessions.sessions.map((session) => session.id)).toEqual([id("s1")]);
    expect(first.closed).toBe(true);
    expect(daemon.connections).toHaveLength(1);

    first.end();
    await stopped;

    expect(connection.status.kind).toBe("idle");
  });
});

describe("requests", () => {
  test("acknowledged resolves, text resolves its payload, failed rejects", async () => {
    const { connection, handshake } = harness();
    const peer = await handshake(undefined);
    const terminal = terminalID();

    const renamed = connection.request({
      type: "renameSession",
      sessionID: id("s1"),
      name: "new",
    });

    const text = connection.request({
      type: "snapshotText",
      terminalID: terminal,
      includeScrollback: false,
    });

    await until(() => peer.controls().length === 4, "both requests");

    expect(peer.controls()[2]).toMatchObject({ type: "renameSession", id: 2 });
    expect(peer.controls()[3]).toMatchObject({ type: "snapshotText", id: 3 });

    peer.say({ type: "text", id: 3 as RequestID, text: "on screen" });
    peer.say({ type: "acknowledged", id: 2 as RequestID });

    expect(await renamed).toBeUndefined();
    expect(await text).toBe("on screen");

    const failing = connection.request({
      type: "removeProject",
      projectID: fixtureID<"Project">("p"),
    });

    await until(() => peer.controls().length === 5, "the third request");
    peer.say({
      type: "failed",
      id: 4 as RequestID,
      failure: { summary: "Couldn't remove the project.", reason: "It has open sessions." },
    });

    const error = await failing.then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({
      summary: "Couldn't remove the project.",
      reason: "It has open sessions.",
      recoverySuggestion: undefined,
    });
  });

  test("a resize carries no id and expects no reply", async () => {
    const { connection, handshake } = harness();
    const peer = await handshake(undefined);

    expect(
      await connection.request({
        type: "resize",
        terminalID: terminalID(),
        size: { columns: 80, rows: 24 },
      }),
    ).toBeUndefined();

    const message = peer.controls()[2];

    expect(message).toMatchObject({ type: "resize" });
    expect(Object.hasOwn(message ?? {}, "id")).toBe(false);
  });

  test("a request with no connection fails fast rather than queueing", async () => {
    const { connection } = harness();

    await expect(
      connection.request({ type: "renameSession", sessionID: id("s1"), name: "x" }),
    ).rejects.toBeInstanceOf(ConnectionUnavailable);
  });

  test("a reply for a request nobody is waiting on is logged, not thrown", async () => {
    const { connection, handshake, logger } = harness();
    const peer = await handshake(undefined);

    peer.say({ type: "acknowledged", id: 99 as RequestID });
    await until(() => logger.with("reply for unknown request").length > 0, "the log line");

    expect(connection.status.kind).toBe("connected");
  });
});

describe("terminal traffic", () => {
  test("input reaches the daemon byte for byte, valid UTF-8 or not", async () => {
    const { connection, handshake } = harness();
    const peer = await handshake(undefined);
    const terminal = terminalID();

    const invalid = Uint8Array.of(0xff, 0xfe, 0x80, 0xc3, 0x28);
    connection.sendInput(invalid, terminal);
    await until(() => peer.inputs().length === 1, "the input frame");

    const sent = peer.inputs()[0];

    expect(sent?.terminalID).toBe(terminal);
    expect(Array.from(sent?.bytes ?? [])).toEqual(Array.from(invalid));
    expect(peer.sent.at(-1)?.kind).toBe(FrameKind.Input);
  });

  test("input while disconnected is dropped, not buffered", async () => {
    const { daemon, connection, handshake } = harness();
    const first = await handshake(undefined);
    const terminal = terminalID();

    first.end();
    await until(() => connection.status.kind === "reconnecting", "the reconnect");
    connection.sendInput(bytes("lost"), terminal);

    const second = await handshake(1);
    connection.sendInput(bytes("kept"), terminal);
    await until(() => second.inputs().length === 1, "the input frame");

    expect(second.inputs()).toHaveLength(1);
    expect(new TextDecoder().decode(second.inputs()[0]?.bytes)).toBe("kept");
    expect(daemon.connections).toHaveLength(2);
  });

  test("output is routed to the handler for its terminal, and dropped after detach", async () => {
    const { connection, handshake, sessions, logger } = harness();
    const peer = await handshake(undefined);
    const [one, two] = [terminalID(), terminalID()];

    peer.say(stateMessage(snapshot([fakeSession("s1", [one, two])])));
    await until(() => sessions.sessions.length === 1, "the snapshot");

    const received: string[] = [];
    const decoder = new TextDecoder();

    const stop = connection.onOutput(one, (chunk) => {
      received.push(decoder.decode(chunk));
    });

    peer.output(one, bytes("hello"));
    await until(() => received.length === 1, "the output");

    expect(received).toEqual(["hello"]);

    peer.output(two, bytes("nobody"));
    await until(
      () => logger.with("output for unwatched terminal").length === 1,
      "the dropped-output log line",
    );

    stop();
    peer.output(one, bytes("late"));
    await until(
      () => logger.with("output for unwatched terminal").length === 2,
      "the second dropped-output line",
    );

    expect(received).toEqual(["hello"]);
    expect(logger.with("output for unwatched terminal")[1]?.fields).toEqual({ terminalID: one });
    expect(connection.status.kind).toBe("connected");
  });

  test("output naming a terminal we do not hold closes the connection", async () => {
    const { daemon, connection, handshake, sessions, logger } = harness();
    const peer = await handshake(undefined);

    peer.say(stateMessage(snapshot([fakeSession("s1", [terminalID()])])));
    await until(() => sessions.sessions.length === 1, "the snapshot");

    const stranger = terminalID();
    peer.output(stranger, bytes("who?"));
    await until(() => connection.status.kind !== "connected", "the connection to drop");

    expect(logger.with("connection lost")[0]?.fields).toEqual({
      error: "unknownTerminal",
      terminalID: stranger,
    });

    expect(sessions.sessions[0]?.terminals.map((terminal) => terminal.id)).not.toContain(stranger);

    await until(() => daemon.connections.length === 2, "the reconnect");
  });

  test("an Input frame from the daemon is a direction violation", async () => {
    const { connection, handshake, logger } = harness();
    const peer = await handshake(undefined);

    const payload = new Uint8Array(RAW_HEADER_LENGTH + 1);
    peer.push(encodeFrame({ kind: FrameKind.Input, payload }));
    await until(() => connection.status.kind !== "connected", "the connection to drop");

    expect(logger.with("connection lost")[0]?.fields).toEqual({ error: "unexpectedKind" });
  });

  test("a terminalExited is merged as the fact it is", async () => {
    const { connection, handshake, sessions } = harness();
    const peer = await handshake(undefined);
    const terminal = terminalID();

    peer.say(
      stateMessage(
        snapshot([fakeSession("s1", [terminal])], [], {
          [terminal]: { kind: "running" },
        }),
      ),
    );

    await until(() => sessions.sessions.length === 1, "the snapshot");

    expect(sessions.isRunning(id("s1"))).toBe(true);

    peer.say({ type: "terminalExited", terminalID: terminal, code: 3 });
    await until(() => sessions.terminalStates[terminal]?.kind === "exited", "the exit");

    expect(sessions.terminalStates[terminal]).toEqual({ kind: "exited", code: 3 });
    expect(sessions.isRunning(id("s1"))).toBe(false);
    expect(connection.status.kind).toBe("connected");
  });
});

describe("attention", () => {
  test("signals reach the handler, and their body reaches nothing else", async () => {
    const { connection, handshake, logger, sessions, projects } = harness();
    const peer = await handshake(undefined);
    const terminal = terminalID();
    const body = "SECRET-BODY-4c1f";

    const delivered: string[] = [];
    connection.onAttention((signal) => {
      delivered.push(signal.id);
    });

    peer.say({
      type: "attention",
      signal: {
        kind: { kind: "notification", title: "SECRET-TITLE", body },
        terminalID: terminal,
        sessionID: id("s1"),
        id: "signal-1",
        occurredAt: instant("2026-01-01T00:00:00.000Z"),
      },
    });

    await until(() => delivered.length === 1, "the signal");

    expect(delivered).toEqual(["signal-1"]);
    expect(logger.text()).not.toContain(body);
    expect(logger.text()).not.toContain("SECRET-TITLE");

    const mirrored = JSON.stringify([
      sessions.sessions,
      projects.projects,
      sessions.terminalStates,
    ]);

    expect(mirrored).not.toContain(body);
  });

  test("handlers can be removed", async () => {
    const { connection, handshake } = harness();
    const peer = await handshake(undefined);
    let count = 0;

    const stop = connection.onAttention(() => {
      count += 1;
    });

    const signal = {
      type: "attention" as const,
      signal: {
        kind: { kind: "bell" as const },
        terminalID: terminalID(),
        sessionID: id("s1"),
        id: "signal-1",
        occurredAt: instant("2026-01-01T00:00:00.000Z"),
      },
    };

    peer.say(signal);
    await until(() => count === 1, "the first signal");

    stop();
    peer.say(signal);
    await Bun.sleep(2);

    expect(count).toBe(1);
  });
});

describe("disconnect", () => {
  test("closes the transport, stops retrying, and can be reconnected", async () => {
    const { daemon, connection, handshake, delays } = harness();
    const first = await handshake(undefined);

    await connection.disconnect();

    expect(connection.status).toEqual({ kind: "idle" });
    expect(first.closed).toBe(true);
    expect(connection.isStale).toBe(true);
    expect(delays.calls).toEqual([]);
    expect(daemon.connections).toHaveLength(1);

    const second = await handshake(1);

    expect(connection.status.kind).toBe("connected");
    expect(second.controls()[0]).toMatchObject({ type: "hello" });
  });

  test("a refusal is retried only after the user acts", async () => {
    const { daemon, connection } = harness();

    void connection.connect();
    await until(() => daemon.connections.length === 1, "a connection");
    const first = daemon.connections[0];

    if (first === undefined) throw new Error("no connection");

    await until(() => first.controls().length > 0, "the hello");
    first.say({ type: "refused", refusal: { kind: "protocolViolation" } });
    await until(() => connection.status.kind === "refused", "the refusal");

    await connection.connect();
    await Bun.sleep(5);

    expect(daemon.connections).toHaveLength(1);

    await connection.disconnect();
    void connection.connect();
    await until(() => daemon.connections.length === 2, "the second attempt");
  });

  test("in-flight requests fail rather than waiting forever", async () => {
    const { connection, handshake } = harness();
    await handshake(undefined);

    const rejection = connection
      .request({ type: "removeSession", sessionID: id("s1"), deletesDirectory: false })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );

    await connection.disconnect();

    expect(await rejection).toBeInstanceOf(ConnectionUnavailable);
  });

  test("subscribers hear every status change", async () => {
    const { connection, handshake } = harness();
    const seen: string[] = [];
    connection.subscribe(() => {
      seen.push(connection.status.kind);
    });

    const peer = await handshake(undefined);
    peer.end();
    await until(() => connection.status.kind === "reconnecting", "the reconnect");

    const transitions = seen.filter((kind, index) => kind !== seen[index - 1]);

    expect(transitions.slice(0, 3)).toEqual(["connecting", "connected", "reconnecting"]);
  });
});

describe("a transport that will not open", () => {
  test("is a failed attempt, logged by shape and retried", async () => {
    const { daemon, connection, delays, logger } = harness();
    daemon.refuseOpens = 1;

    await connection.connect();
    await until(() => daemon.connections.length === 1, "the second attempt");

    expect(delays.calls).toEqual([250]);
    expect(logger.with("transport unavailable")[0]?.fields).toEqual({ attempt: 0, error: "Error" });
  });

  test("a send that fails takes the connection down once, not twice", async () => {
    const { daemon, connection, handshake } = harness();
    const first = await handshake(undefined);
    first.writesFail = true;

    const pending = connection.request({ type: "renameSession", sessionID: id("s1"), name: "x" });

    await expect(pending).rejects.toBeInstanceOf(ConnectionUnavailable);

    await until(() => daemon.connections.length === 2, "exactly one reconnect");
    await Bun.sleep(5);

    expect(daemon.connections).toHaveLength(2);
  });
});
