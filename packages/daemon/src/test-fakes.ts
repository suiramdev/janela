import type {
  AbsolutePath,
  GridSize,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
} from "@janela/core";
import {
  decodeDaemonMessage,
  encodeClientMessage,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type Hello,
  type MessageTransport,
} from "@janela/protocol";
import type { ProjectService, SessionCreationRequest, SessionService } from "@janela/session";
import type { LogRecord, Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";

import type { PeerCredential } from "./endpoint.ts";
import type {
  AcceptedConnection,
  ClientConnection,
  ConnectionListening,
  RequestDispatching,
} from "./server.ts";

/**
 * Fakes for the daemon's own tests.
 *
 * Not exported from `index.ts`: these exist for `*.test.ts` in this package and
 * nothing ships them. Automation, registries and transports are faked because the
 * logic under test is the *decision* — which client gets which frame, and who is
 * disconnected — not the socket. The socket has its own tests, against a real one.
 */

export interface FakeDispatch extends RequestDispatching {
  readonly requests: { readonly client: string; readonly type: ClientMessage["type"] }[];
  readonly inputs: {
    readonly client: string;
    readonly terminalID: TerminalID;
    readonly text: string;
  }[];
  /** Set to make `input` throw, which must not cost the connection. */
  failure: Error | undefined;
}

/**
 * A dispatcher that does the two things the server's own contract needs —
 * register a subscription and register a viewport — and records the rest.
 *
 * What a `createSession` *means* is the request dispatcher's; what a connection
 * does with a `subscribe` is the server's, and that is the line this fake draws.
 */
export function fakeDispatch(registry: TerminalRegistry): FakeDispatch {
  const decoder = new TextDecoder();
  const dispatch: FakeDispatch = {
    requests: [],
    inputs: [],
    failure: undefined,

    request(connection: ClientConnection, message: ClientMessage): Promise<void> {
      dispatch.requests.push({ client: connection.id, type: message.type });
      switch (message.type) {
        case "subscribe":
          connection.subscribe(message.scope);
          break;
        case "attach": {
          const terminal = registry.get(message.terminalID);
          if (terminal !== undefined) connection.attach(terminal, message.viewport);
          break;
        }
        case "detach":
          connection.detach(message.terminalID);
          break;
        default:
          break;
      }
      if ("id" in message) connection.send({ type: "acknowledged", id: message.id });
      return Promise.resolve();
    },

    input(connection: ClientConnection, terminal, bytes): void {
      if (dispatch.failure !== undefined) throw dispatch.failure;
      dispatch.inputs.push({
        client: connection.id,
        terminalID: terminal.id,
        text: decoder.decode(bytes),
      });
    },
  };
  return dispatch;
}

export interface Recorded {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: Recorded[];
  /** Every record with this message, in order. */
  with(message: string): Recorded[];
}

export function recordingLogger(): RecordingLogger {
  const records: Recorded[] = [];
  const at =
    (level: Recorded["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
      records.push({ level, message, fields });
    };
  return {
    logger: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
    with: (message) => records.filter((record) => record.message === message),
  };
}

export interface FakeTerminalOptions {
  readonly state?: TerminalState;
  /** Bytes `repaintFor` returns. Empty means "nothing changed". */
  readonly delta?: Uint8Array;
  readonly full?: Uint8Array;
  /** Thrown by both encoders, to exercise the loop's lost-terminal path. */
  readonly throwOnRepaint?: Error;
  /**
   * Thrown by `drain`, which is what a real terminal does when its descriptor is
   * lost — `PseudoTerminalFailure` with `detail.kind === "readFailed"` (#17).
   */
  readonly throwOnDrain?: Error;
}

export interface FakeTerminal extends LiveTerminal {
  /** Client ids passed to `repaintFor`, in call order. */
  readonly repaintCalls: string[];
  readonly fullRepaintCalls: string[];
  /** How often the frame loop fed this terminal. One per frame, or the loop is wrong. */
  readonly drainCalls: { count: number };
  readonly attached: Map<string, GridSize>;
  readonly sendCalls: Uint8Array[];
  readonly stopCalls: { count: number };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

export function fakeTerminal(id: TerminalID, options: FakeTerminalOptions = {}): FakeTerminal {
  const delta = options.delta ?? bytes("d");
  const full = options.full ?? bytes("F");
  const repaintCalls: string[] = [];
  const fullRepaintCalls: string[] = [];
  const drainCalls = { count: 0 };
  const attached = new Map<string, GridSize>();
  const sendCalls: Uint8Array[] = [];
  const stopCalls = { count: 0 };

  const descriptor: TerminalDescriptor = {
    id,
    title: "fake",
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: "2026-01-01T00:00:00.000Z" as TerminalDescriptor["createdAt"],
  };

  return {
    id,
    sessionID: "session" as SessionID,
    descriptor,
    state: options.state ?? { kind: "running" },
    displayTitle: "fake",
    repaintCalls,
    fullRepaintCalls,
    drainCalls,
    attached,
    sendCalls,
    stopCalls,
    start: () => Promise.resolve(),
    stop: () => {
      stopCalls.count += 1;
      return Promise.resolve();
    },
    restart: () => Promise.resolve(),
    drain: () => {
      drainCalls.count += 1;
      if (options.throwOnDrain !== undefined) throw options.throwOnDrain;
    },
    send: (input) => {
      sendCalls.push(Uint8Array.from(input));
    },
    attach: (client, viewport) => {
      attached.set(client, viewport);
      return viewport;
    },
    detach: (client) => {
      attached.delete(client);
      return attached.size === 0 ? undefined : { columns: 80, rows: 24 };
    },
    repaintFor: (client) => {
      if (options.throwOnRepaint !== undefined) throw options.throwOnRepaint;
      repaintCalls.push(client);
      return delta;
    },
    fullRepaintFor: (client) => {
      if (options.throwOnRepaint !== undefined) throw options.throwOnRepaint;
      fullRepaintCalls.push(client);
      return full;
    },
    snapshotText: () => "",
    events: undefined,
  };
}

export interface FakeRegistry extends TerminalRegistry {
  readonly registerCalls: { count: number };
  readonly hangUpAllCalls: { count: number };
  add(terminal: LiveTerminal): void;
}

export function fakeRegistry(terminals: readonly LiveTerminal[] = []): FakeRegistry {
  const held = new Map<TerminalID, LiveTerminal>(
    terminals.map((terminal) => [terminal.id, terminal]),
  );
  const registerCalls = { count: 0 };
  const hangUpAllCalls = { count: 0 };

  return {
    registerCalls,
    hangUpAllCalls,
    add: (terminal) => {
      held.set(terminal.id, terminal);
    },
    get: (id) => held.get(id),
    register: (terminal) => {
      registerCalls.count += 1;
      held.set(terminal.id, terminal);
    },
    remove: (id) => {
      held.delete(id);
    },
    inSession: (id) => [...held.values()].filter((terminal) => terminal.sessionID === id),
    get liveCount(): number {
      return [...held.values()].filter((terminal) => terminal.state.kind === "running").length;
    },
    hangUpAll: () => {
      hangUpAllCalls.count += 1;
      return Promise.resolve();
    },
  };
}

/**
 * One direction of a transport pair: a frame is handed over only once the other
 * side's consumer takes it.
 *
 * A rendezvous rather than a buffer, because the interesting daemon behaviour is
 * exactly what happens when a peer stops reading — a buffered channel would let a
 * stalled client look healthy.
 */
class Channel {
  #items: Frame[] = [];
  #takers: ((frame: Frame | undefined) => void)[] = [];
  #senders: { readonly frame: Frame; readonly resolve: () => void }[] = [];
  #closed = false;

  send(frame: Frame): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("transport closed"));
    const taker = this.#takers.shift();
    if (taker !== undefined) {
      taker(frame);
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#senders.push({ frame, resolve });
    this.#items.push(frame);
    return promise;
  }

  take(): Promise<Frame | undefined> {
    const item = this.#items.shift();
    if (item !== undefined) {
      const sender = this.#senders.shift();
      sender?.resolve();
      return Promise.resolve(item);
    }
    if (this.#closed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<Frame | undefined>();
    this.#takers.push(resolve);
    return promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const taker of this.#takers.splice(0)) taker(undefined);
    // A sender waiting on a peer that went away is released, not rejected: the
    // frame is lost because the connection is gone.
    for (const sender of this.#senders.splice(0)) sender.resolve();
    this.#items = [];
  }

  /** Frames sent but not yet taken. */
  get queued(): number {
    return this.#items.length;
  }
}

export interface TransportPair {
  readonly daemonSide: MessageTransport;
  readonly clientSide: MessageTransport;
  /** Frames the daemon sent that the client has not read. */
  readonly unreadByClient: number;
}

/** One end of a `transportPair`. */
function transportSide(outgoing: Channel, incoming: Channel): MessageTransport {
  return {
    async *incoming(): AsyncIterableIterator<Frame> {
      for (;;) {
        // A rendezvous: one frame at a time, only when the consumer asks.
        // oxlint-disable-next-line no-await-in-loop
        const frame = await incoming.take();
        if (frame === undefined) return;
        yield frame;
      }
    },
    send: (frame) => outgoing.send(frame),
    close: () => {
      outgoing.close();
      incoming.close();
      return Promise.resolve();
    },
  };
}

export function transportPair(): TransportPair {
  const toClient = new Channel();
  const toDaemon = new Channel();

  return {
    daemonSide: transportSide(toClient, toDaemon),
    clientSide: transportSide(toDaemon, toClient),
    get unreadByClient(): number {
      return toClient.queued;
    },
  };
}

export interface MemoryListener extends ConnectionListening {
  /** Connects a peer and returns the client end of its transport. */
  connect(credential?: PeerCredential): TransportPair;
  readonly closeCalls: { count: number };
}

const OWN_UID = 501;

export function memoryListener(): MemoryListener {
  const pending: AcceptedConnection[] = [];
  let waiting: (() => void) | undefined;
  let closed = false;
  const closeCalls = { count: 0 };

  return {
    closeCalls,
    connect(credential = { uid: OWN_UID, pid: 4242 }): TransportPair {
      const pair = transportPair();
      pending.push({ transport: pair.daemonSide, credential });
      const wake = waiting;
      waiting = undefined;
      wake?.();
      return pair;
    },
    async *accept(): AsyncIterableIterator<AcceptedConnection> {
      // `closed` is set by `close()`, which wakes the parked waiter below.
      // oxlint-disable-next-line no-unmodified-loop-condition
      while (!closed) {
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        waiting = resolve;
        // oxlint-disable-next-line no-await-in-loop
        await promise;
      }
    },
    close(): Promise<void> {
      closeCalls.count += 1;
      closed = true;
      const wake = waiting;
      waiting = undefined;
      wake?.();
      return Promise.resolve();
    },
  };
}

/** A client `hello`, compatible unless the overrides say otherwise. */
export function clientHello(overrides: Partial<Hello> = {}): Frame {
  return encodeClientMessage({
    type: "hello",
    hello: {
      protocolVersion: PROTOCOL_VERSION,
      minimumSupported: MINIMUM_SUPPORTED_VERSION,
      clientName: "test",
      ...overrides,
    },
  });
}

/** A `hello` whose fields are the wrong types — the wire has no type system. */
export function malformedHello(hello: unknown): Frame {
  return encodeClientMessage({ type: "hello", hello } as ClientMessage);
}

/** The next control message the peer sends, decoded. */
export async function readMessage(transport: MessageTransport): Promise<DaemonMessage> {
  for await (const frame of transport.incoming()) {
    return decodeDaemonMessage(frame);
  }
  throw new Error("the peer closed without sending a message");
}

/** The next frame, whatever kind it is. */
export async function readFrame(transport: MessageTransport): Promise<Frame> {
  for await (const frame of transport.incoming()) {
    return frame;
  }
  throw new Error("the peer closed without sending a frame");
}

const NOT_CALLED = "the daemon must not call this";

export function fakeSessions(sessions: readonly Session[] = []): SessionService {
  return {
    sessions,
    load: () => Promise.resolve(),
    find: (id) => sessions.find((session) => session.id === id),
    inProject: (id) => sessions.filter((session) => session.projectID === id),
    get standaloneSessions(): readonly Session[] {
      return sessions.filter((session) => session.projectID === undefined);
    },
    createSession: (_request: SessionCreationRequest) => Promise.reject(new Error(NOT_CALLED)),
    removalPlan: () => Promise.reject(new Error(NOT_CALLED)),
    removeSession: () => Promise.reject(new Error(NOT_CALLED)),
    rename: () => Promise.reject(new Error(NOT_CALLED)),
    startTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    stopTerminal: () => Promise.reject(new Error(NOT_CALLED)),
  };
}

export function fakeProjects(projects: readonly Project[] = []): ProjectService {
  return {
    projects,
    load: () => Promise.resolve(),
    find: (id) => projects.find((project) => project.id === id),
    addProject: () => Promise.reject(new Error(NOT_CALLED)),
    removeProject: () => Promise.reject(new Error(NOT_CALLED)),
    updateSettings: () => Promise.reject(new Error(NOT_CALLED)),
  };
}

/** A session, for the fan-out tests. Only the fields a `state` update carries. */
export function fakeSession(id: string): Session {
  return {
    id: id as SessionID,
    name: id,
    directory: `/tmp/${id}` as AbsolutePath,
    backing: { kind: "folder" },
    terminals: [],
    layout: { tabs: [], focusedTabIndex: 0 },
    accent: "none",
    createdAt: "2026-01-01T00:00:00.000Z" as Session["createdAt"],
    lastActiveAt: "2026-01-01T00:00:00.000Z" as Session["lastActiveAt"],
    isPinned: false,
  };
}

export function fakeProject(id: string): Project {
  return {
    id: id as ProjectID,
    name: id,
    directory: `/tmp/${id}` as AbsolutePath,
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: [],
      isForgeEnabled: false,
    },
    accent: "none",
    isExpanded: true,
    addedAt: "2026-01-01T00:00:00.000Z" as Project["addedAt"],
  };
}
