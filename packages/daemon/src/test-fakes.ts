import {
  absolutePath,
  identifier,
  instant,
  type GridSize,
  type Identifier,
  type LaunchProfile,
  type LaunchProfileID,
  type Project,
  type Session,
  type SessionID,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import {
  FrameKind,
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
import type {
  DirectoryBrowsing,
  DirectoryListing,
  LaunchProfileService,
  ProjectService,
  SessionCreationRequest,
  SessionService,
} from "@janela/session";
import type { LogRecord, Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry, TerminalRegistryObserving } from "@janela/terminal";
import { Match } from "effect";

import type { ClientConnection, RequestDispatching } from "./dispatch.ts";
import type { PeerCredential } from "./endpoint.ts";
import type { AcceptedConnection, ConnectionListening } from "./server.ts";

export type WireValue =
  | string
  | number
  | boolean
  | null
  | readonly WireValue[]
  | { readonly [field: string]: WireValue };

export interface FakeDispatch extends RequestDispatching {
  readonly requests: { readonly client: string; readonly type: ClientMessage["type"] }[];
  readonly inputs: {
    readonly client: string;
    readonly terminalID: TerminalID;
    readonly text: string;
  }[];
}

export interface Recorded {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: Recorded[];
  with(message: string): Recorded[];
}

export interface FakeTerminalOptions {
  readonly state?: TerminalState;
  readonly delta?: Uint8Array;
  readonly full?: Uint8Array;
  readonly throwOnRepaint?: Error;
  readonly throwOnDrain?: Error;
  readonly throwOnSend?: Error;
  readonly snapshot?: string;
  readonly sessionID?: SessionID;
}

export interface FakeTerminal extends LiveTerminal {
  readonly repaintCalls: string[];
  readonly fullRepaintCalls: string[];
  readonly drainCalls: { count: number };
  readonly attached: Map<string, GridSize>;
  readonly attachCalls: { client: string; viewport: GridSize }[];
  readonly sendCalls: Uint8Array[];
  readonly stopCalls: { count: number };
  readonly startCalls: { count: number };
  setState(state: TerminalState): void;
}

export interface FakeRegistry extends TerminalRegistry {
  readonly registerCalls: { count: number };
  readonly hangUpAllCalls: { count: number };
  add(terminal: LiveTerminal): void;
}

export interface TransportPair {
  readonly daemonSide: MessageTransport;
  readonly clientSide: MessageTransport;
  readonly unreadByClient: number;
}

export interface MemoryListener extends ConnectionListening {
  connect(credential?: PeerCredential): TransportPair;
  readonly closeCalls: { count: number };
}

const OWN_UID = 501;

const FIXTURE_INSTANT = instant("2026-01-01T00:00:00.000Z");

const NOT_CALLED = "the daemon must not call this";

const encoder = new TextEncoder();

function fixtureIdentifier<Subject extends string>(name: string): Identifier<Subject> {
  const digest = new Bun.CryptoHasher("md5").update(name).digest("hex");

  return identifier<Subject>(
    [
      digest.slice(0, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 32),
    ].join("-"),
  );
}

export function fakeDispatch(registry: TerminalRegistry): FakeDispatch {
  const decoder = new TextDecoder();
  const dispatch: FakeDispatch = {
    requests: [],
    inputs: [],

    request(connection: ClientConnection, message: ClientMessage): Promise<void> {
      dispatch.requests.push({ client: connection.id, type: message.type });

      Match.value(message).pipe(
        Match.discriminator("type")("subscribe", (request) => {
          connection.subscribe(request.scope);
        }),
        Match.discriminator("type")("attach", (request) => {
          const terminal = registry.get(request.terminalID);

          if (terminal !== undefined) connection.attach(terminal, request.viewport);
        }),
        Match.discriminator("type")("detach", (request) => {
          connection.detach(request.terminalID);
        }),
        Match.orElse(() => undefined),
      );

      if (message.type !== "hello" && message.type !== "resize") {
        connection.send({ type: "acknowledged", id: message.id });
      }

      return Promise.resolve();
    },

    input(connection: ClientConnection, terminal, bytes): void {
      dispatch.inputs.push({
        client: connection.id,
        terminalID: terminal.id,
        text: decoder.decode(bytes),
      });
    },
  };

  return dispatch;
}

export function recordingLogger(): RecordingLogger {
  const records: Recorded[] = [];
  const at =
    (level: Recorded["level"]) =>
    (message: string, fields: LogRecord["fields"]): void => {
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

export function fakeTerminal(id: TerminalID, options: FakeTerminalOptions = {}): FakeTerminal {
  const delta = options.delta ?? encoder.encode("d");
  const full = options.full ?? encoder.encode("F");
  const repaintCalls: string[] = [];
  const fullRepaintCalls: string[] = [];
  const drainCalls = { count: 0 };
  const attached = new Map<string, GridSize>();
  const sendCalls: Uint8Array[] = [];
  const stopCalls = { count: 0 };
  const startCalls = { count: 0 };
  const attachCalls: { client: string; viewport: GridSize }[] = [];
  let current: TerminalState = options.state ?? { kind: "running" };

  const descriptor: TerminalDescriptor = {
    id,
    title: "fake",
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: FIXTURE_INSTANT,
  };

  return {
    id,
    sessionID: options.sessionID ?? fixtureIdentifier<"Session">("session"),
    descriptor,
    get state(): TerminalState {
      return current;
    },
    setState: (state) => {
      current = state;
    },
    displayTitle: "fake",
    repaintCalls,
    fullRepaintCalls,
    drainCalls,
    attached,
    attachCalls,
    sendCalls,
    stopCalls,
    startCalls,
    start: () => {
      startCalls.count += 1;

      return Promise.resolve();
    },
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
      if (options.throwOnSend !== undefined) throw options.throwOnSend;

      sendCalls.push(Uint8Array.from(input));
    },
    attach: (client, viewport) => {
      attachCalls.push({ client, viewport });
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
    snapshotText: ({ includeScrollback }) =>
      includeScrollback ? `${options.snapshot ?? ""}+scrollback` : (options.snapshot ?? ""),
    events: undefined,
  };
}

export function fakeRegistry(terminals: readonly LiveTerminal[] = []): FakeRegistry {
  const held = new Map<TerminalID, LiveTerminal>(
    terminals.map((terminal) => [terminal.id, terminal]),
  );
  const registerCalls = { count: 0 };
  const hangUpAllCalls = { count: 0 };
  let observer: TerminalRegistryObserving | undefined;

  const hold = (terminal: LiveTerminal): void => {
    held.set(terminal.id, terminal);
    observer?.terminalRegistered(terminal);
  };

  return {
    registerCalls,
    hangUpAllCalls,
    add: hold,
    get: (id) => held.get(id),
    watch: (watcher) => {
      observer = watcher;

      for (const terminal of held.values()) watcher.terminalRegistered(terminal);
    },
    register: (terminal) => {
      registerCalls.count += 1;
      hold(terminal);
    },
    remove: (id) => {
      if (held.delete(id)) observer?.terminalRemoved(id);
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

export function wireControl(value: WireValue): Frame {
  return { kind: FrameKind.Control, payload: encoder.encode(JSON.stringify(value)) };
}

export function malformedHello(hello: WireValue): Frame {
  return wireControl({ type: "hello", hello });
}

export async function readMessage(transport: MessageTransport): Promise<DaemonMessage> {
  for await (const frame of transport.incoming()) {
    return decodeDaemonMessage(frame);
  }

  throw new Error("the peer closed without sending a message");
}

export async function readFrame(transport: MessageTransport): Promise<Frame> {
  for await (const frame of transport.incoming()) {
    return frame;
  }

  throw new Error("the peer closed without sending a frame");
}

export function fakeSessions(
  sessions: readonly Session[] = [],
  overrides: Partial<SessionService> = {},
): SessionService {
  return {
    sessions,
    load: () => Promise.resolve(),
    find: (id) => sessions.find((session) => session.id === id),
    inProject: (id) => sessions.filter((session) => session.projectID === id),
    get standaloneSessions(): readonly Session[] {
      return sessions.filter((session) => session.projectID === undefined);
    },
    createSession: (_request: SessionCreationRequest) => Promise.reject(new Error(NOT_CALLED)),
    createTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    removeTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    removalPlan: () => Promise.reject(new Error(NOT_CALLED)),
    branchOverview: () => Promise.reject(new Error(NOT_CALLED)),
    moveTab: () => Promise.reject(new Error(NOT_CALLED)),
    moveTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    removeSession: () => Promise.reject(new Error(NOT_CALLED)),
    rename: () => Promise.reject(new Error(NOT_CALLED)),
    startTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    stopTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    restartTerminal: () => Promise.reject(new Error(NOT_CALLED)),
    ...overrides,
  };
}

export function fakeProjects(
  projects: readonly Project[] = [],
  overrides: Partial<ProjectService> = {},
): ProjectService {
  return {
    projects,
    load: () => Promise.resolve(),
    find: (id) => projects.find((project) => project.id === id),
    addProject: () => Promise.reject(new Error(NOT_CALLED)),
    removeProject: () => Promise.reject(new Error(NOT_CALLED)),
    updateSettings: () => Promise.reject(new Error(NOT_CALLED)),
    ...overrides,
  };
}

export function fakeDirectories(
  list: DirectoryBrowsing["list"] = () => Promise.reject(new Error(NOT_CALLED)),
): DirectoryBrowsing {
  return { list };
}

export function fakeListing(overrides: Partial<DirectoryListing> = {}): DirectoryListing {
  return {
    directory: absolutePath("/Users/ada"),
    home: absolutePath("/Users/ada"),
    entries: [
      { name: "code", kind: "directory" },
      { name: "notes.md", kind: "file" },
    ],
    truncated: false,
    ...overrides,
  };
}

export function fakeLaunchProfiles(
  profiles: readonly LaunchProfile[] = [],
  overrides: Partial<LaunchProfileService> = {},
): LaunchProfileService {
  const availability: Record<LaunchProfileID, boolean> = {};

  for (const profile of profiles) availability[profile.id] = true;

  return {
    profiles,
    availability,
    load: () => Promise.resolve(),
    save: () => Promise.reject(new Error(NOT_CALLED)),
    remove: () => Promise.reject(new Error(NOT_CALLED)),
    ...overrides,
  };
}

export function fakeProfile(id: string, overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: fixtureIdentifier<"LaunchProfile">(id),
    name: id,
    iconName: "terminal",
    command: [id],
    environment: {},
    isAgent: false,
    isBuiltIn: false,
    ...overrides,
  };
}

export function fakeSession(id: string): Session {
  return {
    id: fixtureIdentifier<"Session">(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    backing: { kind: "folder" },
    terminals: [],
    layout: { tabs: [], focusedTabIndex: 0 },
    accent: "none",
    createdAt: FIXTURE_INSTANT,
    lastActiveAt: FIXTURE_INSTANT,
    isPinned: false,
  };
}

export function fakeProject(id: string): Project {
  return {
    id: fixtureIdentifier<"Project">(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: {},
      isForgeEnabled: false,
    },
    accent: "none",
    isExpanded: true,
    addedAt: FIXTURE_INSTANT,
  };
}

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

    for (const sender of this.#senders.splice(0)) sender.resolve();

    this.#items = [];
  }

  get queued(): number {
    return this.#items.length;
  }
}

function transportSide(outgoing: Channel, incoming: Channel): MessageTransport {
  return {
    async *incoming(): AsyncIterableIterator<Frame> {
      for (;;) {
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
