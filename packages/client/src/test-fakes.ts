import {
  absolutePath,
  identifier,
  instant,
  type Identifier,
  type LaunchProfile,
  type Project,
  type ProjectID,
  type Session,
  type TerminalDescriptor,
  type TerminalID,
  type TerminalState,
} from "@janela/core";
import {
  FrameKind,
  PROTOCOL_VERSION,
  MINIMUM_SUPPORTED_VERSION,
  decodeClientMessage,
  decodeInput,
  encodeDaemonMessage,
  encodeFrame,
  encodeOutput,
  frameDecoder,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type MessageTransport,
  type StateUpdate,
  type TerminalInput,
} from "@janela/protocol";
import type { LogRecord, Logger } from "@janela/support";

export interface FakeConnection {
  readonly transport: MessageTransport;
  readonly sent: Frame[];
  controls(): ClientMessage[];
  inputs(): TerminalInput[];
  readonly closed: boolean;
  writesFail: boolean;
  keepsDeliveringAfterClose: boolean;
  push(bytes: Uint8Array): void;
  say(message: DaemonMessage): void;
  output(terminalID: TerminalID, bytes: Uint8Array): void;
  pushHalf(message: DaemonMessage): Uint8Array;
  end(): void;
}

export interface FakeDaemon {
  readonly openTransport: () => MessageTransport;
  readonly connections: FakeConnection[];
  refuseOpens: number;
}

export interface Recorded {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly log: Logger;
  readonly records: Recorded[];
  with(message: string): Recorded[];
  text(): string;
}

export interface FakeDelay {
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly calls: number[];
}

export function terminalID(): TerminalID {
  return identifier<"Terminal">(crypto.randomUUID());
}

export function fixtureID<Subject extends string>(raw: string): Identifier<Subject> {
  // SAFETY: a fixture id is only ever compared for equality inside this package's tests, and `Identifier` brands a string nominally — the brand adds no representation the string does not already have.
  return raw as Identifier<Subject>;
}

class ByteChannel {
  #chunks: Uint8Array[] = [];
  #takers: ((chunk: Uint8Array | undefined) => void)[] = [];
  #closed = false;

  push(chunk: Uint8Array): void {
    if (this.#closed) return;

    const taker = this.#takers.shift();

    if (taker !== undefined) {
      taker(chunk);

      return;
    }

    this.#chunks.push(chunk);
  }

  take(): Promise<Uint8Array | undefined> {
    const chunk = this.#chunks.shift();

    if (chunk !== undefined) return Promise.resolve(chunk);

    if (this.#closed) return Promise.resolve(undefined);

    const { promise, resolve } = Promise.withResolvers<Uint8Array | undefined>();
    this.#takers.push(resolve);

    return promise;
  }

  close(): void {
    if (this.#closed) return;

    this.#closed = true;

    for (const taker of this.#takers.splice(0)) taker(undefined);
  }
}

function fakeConnection(): FakeConnection {
  const toClient = new ByteChannel();
  const sent: Frame[] = [];
  let closed = false;

  const connection: FakeConnection = {
    sent,
    writesFail: false,
    keepsDeliveringAfterClose: false,

    get closed(): boolean {
      return closed;
    },

    controls: () =>
      sent.filter((frame) => frame.kind === FrameKind.Control).map(decodeClientMessage),
    inputs: () => sent.filter((frame) => frame.kind === FrameKind.Input).map(decodeInput),

    push: (bytes) => toClient.push(bytes),
    say: (message) => toClient.push(encodeFrame(encodeDaemonMessage(message))),
    output: (id, bytes) => toClient.push(encodeFrame(encodeOutput({ terminalID: id, bytes }))),

    pushHalf(message: DaemonMessage): Uint8Array {
      const encoded = encodeFrame(encodeDaemonMessage(message));
      const half = Math.floor(encoded.length / 2);
      toClient.push(encoded.subarray(0, half));

      return encoded.subarray(half);
    },

    end: () => toClient.close(),

    transport: {
      async *incoming(): AsyncIterableIterator<Frame> {
        const decoder = frameDecoder();

        for (;;) {
          // oxlint-disable-next-line no-await-in-loop
          const chunk = await toClient.take();

          if (chunk === undefined) {
            decoder.end();

            return;
          }

          for (const frame of decoder.push(chunk)) yield frame;
        }
      },

      send(frame: Frame): Promise<void> {
        if (connection.writesFail) return Promise.reject(new Error("transport closed"));

        if (closed) return Promise.reject(new Error("transport closed"));

        sent.push(frame);

        return Promise.resolve();
      },

      close(): Promise<void> {
        closed = true;

        if (!connection.keepsDeliveringAfterClose) toClient.close();

        return Promise.resolve();
      },
    },
  };

  return connection;
}

export function fakeDaemon(): FakeDaemon {
  const connections: FakeConnection[] = [];

  const daemon: FakeDaemon = {
    connections,
    refuseOpens: 0,
    openTransport: (): MessageTransport => {
      if (daemon.refuseOpens > 0) {
        daemon.refuseOpens -= 1;
        throw new Error("socket unavailable");
      }

      const connection = fakeConnection();
      connections.push(connection);

      return connection.transport;
    },
  };

  return daemon;
}

export function daemonHello(
  overrides: { readonly protocolVersion?: number; readonly minimumSupported?: number } = {},
): DaemonMessage {
  return {
    type: "hello",
    hello: {
      protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
      minimumSupported: overrides.minimumSupported ?? MINIMUM_SUPPORTED_VERSION,
      clientName: "janelad",
    },
  };
}

export async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;

    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }

  throw new Error(`timed out waiting for ${description}`);
}

export async function helloFrom(connection: FakeConnection): Promise<ClientMessage> {
  await until(() => connection.controls().length > 0, "the client's hello");
  const first = connection.controls()[0];

  if (first === undefined) throw new Error("no control message");

  return first;
}

export function recordingLogger(): RecordingLogger {
  const records: Recorded[] = [];

  const at =
    (level: Recorded["level"]) =>
    (message: string, fields: LogRecord["fields"] = undefined): void => {
      records.push({ level, message, fields });
    };

  return {
    log: {
      debug: at("debug"),
      info: at("info"),
      notice: at("notice"),
      warning: at("warning"),
      error: at("error"),
    },
    records,
    with: (message) => records.filter((record) => record.message === message),
    text: () => JSON.stringify(records),
  };
}

export function fakeDelay(): FakeDelay {
  const calls: number[] = [];

  return {
    calls,
    delay: (milliseconds, signal) => {
      calls.push(milliseconds);

      if (signal.aborted) return Promise.resolve();

      const { promise, resolve } = Promise.withResolvers<void>();
      queueMicrotask(resolve);

      return promise;
    },
  };
}

export function fakeTerminalDescriptor(id: TerminalID): TerminalDescriptor {
  return {
    id,
    title: id,
    startsAutomatically: false,
    role: { kind: "user" },
    createdAt: instant("2026-01-01T00:00:00.000Z"),
  };
}

export function fakeSession(
  id: string,
  terminals: readonly TerminalID[] = [],
  projectID: ProjectID | undefined = undefined,
): Session {
  const session: Session = {
    id: fixtureID<"Session">(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    backing: { kind: "folder" },
    terminals: terminals.map(fakeTerminalDescriptor),
    layout: { tabs: [], focusedTabIndex: 0 },
    accent: "none",
    createdAt: instant("2026-01-01T00:00:00.000Z"),
    lastActiveAt: instant("2026-01-01T00:00:00.000Z"),
    isPinned: false,
  };

  return projectID === undefined ? session : { ...session, projectID };
}

export function fakeProject(id: string): Project {
  return {
    id: fixtureID<"Project">(id),
    name: id,
    directory: absolutePath(`/tmp/${id}`),
    settings: {
      worktreeRoot: { kind: "siblingDirectory" },
      automation: {},
      isForgeEnabled: false,
    },
    accent: "none",
    isExpanded: true,
    addedAt: instant("2026-01-01T00:00:00.000Z"),
  };
}

export function snapshot(
  sessions: readonly Session[],
  projects: readonly Project[] = [],
  terminalStates: Readonly<Record<TerminalID, TerminalState>> = {},
  launchProfiles: readonly LaunchProfile[] = [],
): StateUpdate {
  return {
    projects,
    sessions,
    terminalStates,
    launchProfiles,
    launchProfileAvailability: Object.fromEntries(
      launchProfiles.map((profile) => [profile.id, true]),
    ),
    isFullSnapshot: true,
  };
}

export function partial(
  sessions: readonly Session[] = [],
  projects: readonly Project[] = [],
  terminalStates: Readonly<Record<TerminalID, TerminalState>> = {},
  launchProfiles: readonly LaunchProfile[] = [],
): StateUpdate {
  return {
    projects,
    sessions,
    terminalStates,
    launchProfiles,
    launchProfileAvailability: Object.fromEntries(
      launchProfiles.map((profile) => [profile.id, true]),
    ),
    isFullSnapshot: false,
  };
}

export function fakeLaunchProfile(id: string, name = id): LaunchProfile {
  return {
    id: fixtureID<"LaunchProfile">(id),
    name,
    iconName: "terminal",
    command: [],
    environment: {},
    isAgent: false,
    isBuiltIn: false,
  };
}

export function stateMessage(update: StateUpdate): DaemonMessage {
  return { type: "state", update };
}
