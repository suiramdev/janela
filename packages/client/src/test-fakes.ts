import type {
  AbsolutePath,
  Project,
  ProjectID,
  Session,
  SessionID,
  TerminalDescriptor,
  TerminalID,
  TerminalState,
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

/**
 * Fakes for this package's own tests.
 *
 * Not exported from `index.ts`: these exist for `*.test.ts` here and nothing ships
 * them. The daemon has fakes of the same shape and this file deliberately does not
 * import them — a client package may not import a daemon package, and copying two
 * dozen lines is the cheaper half of that rule.
 *
 * **Byte-level on purpose.** The daemon's own fake transport hands over whole
 * `Frame`s, which is right for testing fan-out; it is wrong here, because the
 * requirement is that a daemon killed *mid-frame* cannot corrupt the connection
 * that replaces it. A frame-level fake cannot express half a frame, so this one
 * carries `Uint8Array` chunks and runs the same `frameDecoder()` the real socket
 * transport runs — including `end()` on EOF, which is what turns a half-written
 * frame into a `truncated` error rather than silence.
 */

/**
 * A queue of byte chunks, one direction.
 *
 * Buffered rather than a rendezvous: the client is the thing under test and always
 * reads, and a test needs to push half a frame whether or not anyone is parked on
 * `take()` at that instant.
 */
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

/** One connection a `fakeDaemon` served. */
export interface FakeConnection {
  /** The client end. What `openTransport` returned. */
  readonly transport: MessageTransport;
  /** Frames the client sent, in order. Both kinds. */
  readonly sent: Frame[];
  controls(): ClientMessage[];
  inputs(): TerminalInput[];
  /** True once the client closed its end. */
  readonly closed: boolean;
  /** Set to make every subsequent `send` reject, as a dead socket does. */
  writesFail: boolean;
  /**
   * Keeps yielding frames after `close()`.
   *
   * A transport is allowed to be like this: the desktop app's bridge relays
   * frames from the Rust shell, and frames already in flight when the client
   * closes its end still arrive. What must *not* happen is one of them reaching
   * the mirror, which is what the connection's generation tag prevents.
   */
  keepsDeliveringAfterClose: boolean;
  /** Raw bytes, for the half-frame cases. */
  push(bytes: Uint8Array): void;
  say(message: DaemonMessage): void;
  output(terminalID: TerminalID, bytes: Uint8Array): void;
  /**
   * Pushes the first half of `message`'s frame and returns the rest.
   *
   * The mid-frame kill: follow it with `end()` and the client's decoder reports
   * `truncated`. Pushing the returned remainder afterwards is how a test proves
   * the *old* connection's leftover bytes cannot reach the new mirror.
   */
  pushHalf(message: DaemonMessage): Uint8Array;
  /** EOF, as a daemon that went away produces. */
  end(): void;
}

export interface FakeDaemon {
  /** Detached on purpose: the connection calls it as a bare function. */
  readonly openTransport: () => MessageTransport;
  readonly connections: FakeConnection[];
  /** How many further `openTransport` calls throw before one is served. */
  refuseOpens: number;
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
    output: (terminalID, bytes) => toClient.push(encodeFrame(encodeOutput({ terminalID, bytes }))),

    pushHalf(message: DaemonMessage): Uint8Array {
      const encoded = encodeFrame(encodeDaemonMessage(message));
      const half = Math.floor(encoded.length / 2);
      toClient.push(encoded.subarray(0, half));
      return encoded.subarray(half);
    },

    end: () => toClient.close(),

    transport: {
      /** The real socket transport's shape: fresh decoder, `end()` on EOF. */
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

/** The daemon's own hello, as `packages/daemon/src/server.ts` sends it. */
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

/**
 * Waits for a condition rather than a duration.
 *
 * The connection's own steps are asynchronous — a handshake is two awaits and a
 * pump — so a test that asserts about them has to let microtasks run. Polling the
 * condition keeps a failure pointing at the condition rather than a guessed sleep.
 */
export async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** The client's hello on a connection, once it has been sent. */
export async function helloFrom(connection: FakeConnection): Promise<ClientMessage> {
  await until(() => connection.controls().length > 0, "the client's hello");
  const first = connection.controls()[0];
  if (first === undefined) throw new Error("no control message");
  return first;
}

export interface Recorded {
  readonly level: LogRecord["level"];
  readonly message: string;
  readonly fields: LogRecord["fields"];
}

export interface RecordingLogger {
  readonly log: Logger;
  readonly records: Recorded[];
  /** Every record with this message, in order. */
  with(message: string): Recorded[];
  /** Everything logged, as one string — for proving something is *absent*. */
  text(): string;
}

export function recordingLogger(): RecordingLogger {
  const records: Recorded[] = [];
  const at =
    (level: Recorded["level"]) =>
    (message: string, fields?: LogRecord["fields"]): void => {
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

export interface FakeDelay {
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** Every delay asked for, in order. The backoff schedule, observable. */
  readonly calls: number[];
}

export function fakeDelay(): FakeDelay {
  const calls: number[] = [];
  return {
    calls,
    delay: (milliseconds, signal) => {
      calls.push(milliseconds);
      if (signal.aborted) return Promise.resolve();
      // A microtask rather than a timer: the schedule is asserted from `calls`,
      // and a test that waited 10 s to prove a 10 s cap would be a bad test.
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
    createdAt: "2026-01-01T00:00:00.000Z" as TerminalDescriptor["createdAt"],
  };
}

/** A session, with only the fields a `state` update carries. */
export function fakeSession(
  id: string,
  terminals: readonly TerminalID[] = [],
  projectID?: ProjectID,
): Session {
  const session: Session = {
    id: id as SessionID,
    name: id,
    directory: `/tmp/${id}` as AbsolutePath,
    backing: { kind: "folder" },
    terminals: terminals.map(fakeTerminalDescriptor),
    layout: { tabs: [], focusedTabIndex: 0 },
    accent: "none",
    createdAt: "2026-01-01T00:00:00.000Z" as Session["createdAt"],
    lastActiveAt: "2026-01-01T00:00:00.000Z" as Session["lastActiveAt"],
    isPinned: false,
  };
  // `exactOptionalPropertyTypes`: an absent `projectID` is not an undefined one.
  return projectID === undefined ? session : { ...session, projectID };
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

export function snapshot(
  sessions: readonly Session[],
  projects: readonly Project[] = [],
  terminalStates: Readonly<Record<TerminalID, TerminalState>> = {},
): StateUpdate {
  return { projects, sessions, terminalStates, isFullSnapshot: true };
}

export function partial(
  sessions: readonly Session[] = [],
  projects: readonly Project[] = [],
  terminalStates: Readonly<Record<TerminalID, TerminalState>> = {},
): StateUpdate {
  return { projects, sessions, terminalStates, isFullSnapshot: false };
}

/** A `state` message, ready for `connection.say`. */
export function stateMessage(update: StateUpdate): DaemonMessage {
  return { type: "state", update };
}

export const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;
