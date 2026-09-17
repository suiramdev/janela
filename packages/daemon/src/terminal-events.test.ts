import { afterEach, describe, expect, test } from "bun:test";

import type { Session, TerminalID, TerminalState } from "@janela/core";
import {
  FrameKind,
  decodeDaemonMessage,
  encodeClientMessage,
  type DaemonMessage,
  type Frame,
  type MessageTransport,
  type RequestID,
} from "@janela/protocol";
import type { TerminalEvents } from "@janela/terminal";

import { createDaemonServer, type DaemonServer } from "./server.ts";
import {
  clientHello,
  fakeDirectories,
  fakeDispatch,
  fakeLaunchProfiles,
  fakeProjects,
  fakeRegistry,
  fakeSession,
  fakeSessions,
  fakeTerminal,
  memoryListener,
  recordingLogger,
  type FakeTerminal,
  type MemoryListener,
  type Recorded,
} from "./test-fakes.ts";

interface Watcher {
  readonly controls: () => DaemonMessage[];
  readonly send: (frame: Frame) => Promise<void>;
}

interface Fixture {
  readonly server: DaemonServer;
  readonly listener: MemoryListener;
  readonly records: Recorded[];
  watch(): Promise<Watcher>;
  stop(): Promise<void>;
}

const REQUEST_ID = 1 as RequestID;

const SUBSCRIBE = encodeClientMessage({
  type: "subscribe",
  id: REQUEST_ID,
  scope: { kind: "state" },
});

const running: Fixture[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((active) => active.stop()));
});

async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;

    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }

  throw new Error(`timed out waiting for ${description}`);
}

function reader(transport: MessageTransport): Watcher {
  const frames: Frame[] = [];

  void (async () => {
    for await (const frame of transport.incoming()) frames.push(frame);
  })();

  return {
    send: (frame) => transport.send(frame),
    controls: () =>
      frames.filter((frame) => frame.kind === FrameKind.Control).map(decodeDaemonMessage),
  };
}

function fixture(terminals: readonly FakeTerminal[], sessions: readonly Session[]): Fixture {
  const registry = fakeRegistry(terminals);
  const { logger, records } = recordingLogger();
  const listener = memoryListener();
  const controller = new AbortController();

  const server = createDaemonServer({
    sessions: fakeSessions(sessions),
    projects: fakeProjects(),
    launchProfiles: fakeLaunchProfiles(),
    directories: fakeDirectories(),
    terminals: registry,
    log: logger,
    dispatch: fakeDispatch(registry),
    handshakeDeadlineMs: 25,
  });

  const serving = server.serve(listener, controller.signal);

  const value: Fixture = {
    server,
    listener,
    records,
    async watch(): Promise<Watcher> {
      const client = reader(listener.connect().clientSide);
      await client.send(clientHello());
      await until(() => client.controls().length > 0, "the daemon's hello");
      await client.send(SUBSCRIBE);
      await until(
        () => client.controls().some((message) => message.type === "acknowledged"),
        "the subscription to be acknowledged",
      );

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

function sessionWith(terminal: FakeTerminal): Session {
  const session = fakeSession("s-events");

  return { ...session, id: terminal.sessionID };
}

function statesFor(client: Watcher, id: TerminalID): Readonly<Record<TerminalID, TerminalState>>[] {
  return client
    .controls()
    .flatMap((message) =>
      message.type === "state" && message.update.terminalStates[id] !== undefined
        ? [message.update.terminalStates]
        : [],
    );
}

function events(terminal: FakeTerminal): TerminalEvents {
  const sink = terminal.events;

  if (sink === undefined) throw new Error("the daemon never installed an event sink");

  return sink;
}

describe("a terminal's own events", () => {
  test("a bell in a quiet session is an attention frame and a partial state frame", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();
    const before = client.controls().length;

    terminal.setState({ kind: "needsAttention" });
    events(terminal).onAttention({});

    await until(() => client.controls().length > before, "the bell to reach the client");

    const fresh = client.controls().slice(before);
    const attention = fresh.find((message) => message.type === "attention");
    const state = fresh.find((message) => message.type === "state");

    expect(attention?.type === "attention" && attention.signal.kind).toEqual({ kind: "bell" });
    expect(attention?.type === "attention" && attention.signal.terminalID).toBe(terminal.id);
    expect(attention?.type === "attention" && attention.signal.sessionID).toBe(terminal.sessionID);
    expect(state?.type === "state" && state.update.isFullSnapshot).toBe(false);
    expect(state?.type === "state" && state.update.sessions).toEqual([]);
    expect(state?.type === "state" && state.update.terminalStates).toEqual({
      [terminal.id]: { kind: "needsAttention" },
    });
  });

  test("a notification carries its text to the client but never to the log", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    events(terminal).onAttention({ title: "Claude", body: "JANELA_SECRET_BODY" });

    await until(
      () => client.controls().some((message) => message.type === "attention"),
      "the notification",
    );

    const attention = client.controls().find((message) => message.type === "attention");

    expect(attention?.type === "attention" && attention.signal.kind).toEqual({
      kind: "notification",
      title: "Claude",
      body: "JANELA_SECRET_BODY",
    });
    expect(JSON.stringify(daemon.records)).not.toContain("JANELA_SECRET_BODY");
    expect(JSON.stringify(daemon.records)).not.toContain("Claude");
  });

  test("a finished prompt is attention without raising needsAttention", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    events(terminal).onPromptFinished({ durationSeconds: 12.5, exitCode: 0 });

    await until(
      () => client.controls().some((message) => message.type === "attention"),
      "the prompt-finished signal",
    );

    const attention = client.controls().find((message) => message.type === "attention");

    expect(attention?.type === "attention" && attention.signal.kind).toEqual({
      kind: "promptFinished",
      exitCode: 0,
      durationSeconds: 12.5,
    });

    const states = client.controls().filter((message) => message.type === "state");
    const reported = states.flatMap((message) =>
      message.type === "state" ? Object.values(message.update.terminalStates) : [],
    );

    expect(reported).not.toContainEqual({ kind: "needsAttention" });
  });

  test("an exit is a terminalExited frame and a partial state frame", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    terminal.setState({ kind: "exited", code: 7 });
    events(terminal).onExit(7);

    await until(
      () => client.controls().some((message) => message.type === "terminalExited"),
      "the exit",
    );

    const exited = client.controls().find((message) => message.type === "terminalExited");
    const state = client
      .controls()
      .findLast(
        (message) =>
          message.type === "state" && message.update.terminalStates[terminal.id] !== undefined,
      );

    expect(exited?.type === "terminalExited" && exited.terminalID).toBe(terminal.id);
    expect(exited?.type === "terminalExited" && exited.code).toBe(7);
    expect(state?.type === "state" && state.update.terminalStates).toEqual({
      [terminal.id]: { kind: "exited", code: 7 },
    });
  });
});

describe("the state frames a progress keepalive produces", () => {
  test("a changed progress is published once per change", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    terminal.setState({ kind: "running", progress: { kind: "indeterminate" } });
    events(terminal).onProgress({ kind: "indeterminate" });

    await until(() => statesFor(client, terminal.id).length === 1, "the first progress frame");

    terminal.setState({ kind: "running", progress: { kind: "normal", percent: 40 } });
    events(terminal).onProgress({ kind: "normal", percent: 40 });

    await until(() => statesFor(client, terminal.id).length === 2, "the second progress frame");

    const latest = client
      .controls()
      .findLast(
        (message) =>
          message.type === "state" && message.update.terminalStates[terminal.id] !== undefined,
      );

    expect(latest?.type === "state" && latest.update.terminalStates).toEqual({
      [terminal.id]: { kind: "running", progress: { kind: "normal", percent: 40 } },
    });
  });

  test("an unchanged progress repeated at 1 Hz produces no further frame", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    terminal.setState({ kind: "running", progress: { kind: "indeterminate" } });
    events(terminal).onProgress({ kind: "indeterminate" });

    await until(() => statesFor(client, terminal.id).length === 1, "the first progress frame");

    for (let keepalive = 0; keepalive < 10; keepalive += 1) {
      events(terminal).onProgress({ kind: "indeterminate" });
    }

    terminal.setState({ kind: "running", progress: { kind: "normal", percent: 5 } });
    events(terminal).onProgress({ kind: "normal", percent: 5 });

    await until(() => statesFor(client, terminal.id).length === 2, "the real change after them");

    const frames = statesFor(client, terminal.id);

    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({
      [terminal.id]: { kind: "running", progress: { kind: "normal", percent: 5 } },
    });
  });

  test("clearing progress is a change, so it is published", async () => {
    const terminal = fakeTerminal(crypto.randomUUID() as TerminalID);
    const daemon = fixture([terminal], [sessionWith(terminal)]);
    const client = await daemon.watch();

    terminal.setState({ kind: "running", progress: { kind: "indeterminate" } });
    events(terminal).onProgress({ kind: "indeterminate" });

    await until(() => statesFor(client, terminal.id).length === 1, "the first progress frame");

    terminal.setState({ kind: "running" });
    events(terminal).onProgress(undefined);

    await until(() => statesFor(client, terminal.id).length === 2, "the cleared progress frame");

    const latest = client
      .controls()
      .findLast(
        (message) =>
          message.type === "state" && message.update.terminalStates[terminal.id] !== undefined,
      );

    expect(latest?.type === "state" && latest.update.terminalStates).toEqual({
      [terminal.id]: { kind: "running" },
    });
  });
});
