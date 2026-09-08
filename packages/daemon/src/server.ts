import type { GridSize, Project, Session, TerminalID } from "@janela/core";
import {
  FrameError,
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeInput,
  encodeDaemonMessage,
  encodeOutput,
  isCompatible,
  type ClientMessage,
  type DaemonMessage,
  type Frame,
  type HandshakeRefusal,
  type Hello,
  type MessageTransport,
  type RequestID,
  type StateUpdate,
  type SubscriptionScope,
} from "@janela/protocol";
import type {
  LaunchProfileService,
  ProjectService,
  SessionService,
  StateObserving,
} from "@janela/session";
import { boundedQueue, type BoundedQueue, type Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";

import {
  createRequestDispatch,
  errorName,
  fullStateSnapshot,
  type ClientConnection,
  type RequestDispatching,
} from "./dispatch.ts";
import type { PeerCredential } from "./endpoint.ts";
import { createFrameLoop, type FrameLoop } from "./frame-loop.ts";

/**
 * Accepts connections and fans state out to them.
 *
 * Deliberately thin. Everything a message *means* lives in `@janela/session`; this
 * package owns connections, subscriptions and the handshake, and nothing else. If
 * product logic appears here it is in the wrong package, and the test for that is
 * simple: `@janela/session` must stay usable with no socket at all.
 */
export interface DaemonServer extends StateObserving {
  /**
   * Serves until the signal aborts.
   *
   * @param listener An already-bound listener. In production this wraps the
   *   descriptor launchd handed us, because launchd owns the socket and we never
   *   bind a path ourselves (docs/decisions/0017-daemon-lifecycle.md).
   * @throws Only when the *listener itself* fails — the socket vanishing, or a
   *   descriptor we cannot accept on. A failure on any single connection is handled
   *   and logged rather than thrown, because one client sending nonsense must never
   *   take down a daemon holding another client's terminals.
   */
  serve(listener: ConnectionListening, signal: AbortSignal): Promise<void>;

  /**
   * Broadcasts a state change to every subscriber.
   *
   * Called by `@janela/session` through `StateObserving`, so the brain never learns
   * that sockets exist.
   */
  publish(update: StateUpdate): Promise<void>;

  /**
   * Whether the daemon may exit.
   *
   * False while any terminal is live, however many clients are connected —
   * including none. That asymmetry is the entire feature: the daemon exists to
   * outlive clients, not to serve them.
   */
  canExitWhenIdle(): boolean;

  /** Connected clients, for the "what is running" story on version skew. */
  readonly connectionCount: number;

  /**
   * The repaint clock, so a request dispatcher can attach and detach viewports and
   * a test can run a frame without waiting for one.
   */
  readonly frameLoop: FrameLoop;
}

/**
 * Something that yields connections.
 *
 * An interface so tests can drive the server over an in-process pair while
 * production uses a real socket — and so a future network listener is an
 * implementation rather than a fork inside `serve`.
 */
export interface ConnectionListening {
  accept(): AsyncIterable<AcceptedConnection>;
  close(): Promise<void>;
}

export interface AcceptedConnection {
  readonly transport: MessageTransport;
  /** What the OS says about the peer. Checked before the handshake is read. */
  readonly credential: PeerCredential;
}

/**
 * How long a peer has to say `hello`.
 *
 * A connection that has not handshaken holds a descriptor and a decoder and can
 * be opened by anything that can reach the socket, so it may not wait forever.
 * Five seconds is enormous for a local socket and small enough that a stuck app
 * launch does not accumulate.
 */
export const HANDSHAKE_DEADLINE_MS = 5_000;

/**
 * Coalesced repaints a client may owe before its oldest is dropped.
 *
 * Judgement, not measurement: 32 frames is a quarter-second of 120 Hz output, and
 * a client that far behind gains nothing from older diffs. The frame loop checks
 * for room *before* encoding, so this bound is normally reached rather than
 * exceeded — and a client that reaches it is re-owed a full repaint, which is the
 * only reason dropping a delta is safe (docs/performance.md § A stalled client).
 */
export const OUTPUT_QUEUE_CAPACITY = 32;

/**
 * Control messages a client may owe before it is disconnected.
 *
 * Nothing here is ever dropped: a lost reply or a lost state update is data loss
 * the client cannot detect, because the protocol has no request timeout. Blocking
 * is equally out — `publish` runs inside `@janela/session` and must never wait on
 * a socket (non-negotiable #8). So a peer that has 64 unread control messages,
 * which at human-rate state churn means it has stopped reading, is disconnected.
 * That is lossless: its reconnect re-subscribes and gets a full snapshot.
 */
export const CONTROL_QUEUE_CAPACITY = 64;

/** What the daemon calls itself in its `Hello`. */
export const DAEMON_CLIENT_NAME = "janelad";

/** The daemon's own version range, sent in its `hello` and used to judge a peer's. */
const DAEMON_HELLO: Hello = {
  protocolVersion: PROTOCOL_VERSION,
  minimumSupported: MINIMUM_SUPPORTED_VERSION,
  clientName: DAEMON_CLIENT_NAME,
};

/** Longest peer-supplied `clientName` that reaches a log. */
const CLIENT_NAME_LOG_LIMIT = 64;

export interface DaemonServerOptions {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  /** Read for every announcement, and written by `saveLaunchProfile`. */
  readonly launchProfiles: LaunchProfileService;
  readonly terminals: TerminalRegistry;
  readonly log: Logger;
  readonly dispatch?: RequestDispatching;
  /** Test hook. Production uses `HANDSHAKE_DEADLINE_MS`. */
  readonly handshakeDeadlineMs?: number;
}

/** Why a connection is being closed. Also the log message, where there is one. */
type CloseReason =
  | "client disconnected"
  | "connection failed"
  | "daemon stopping"
  | "handshake timed out"
  | "peer left during handshake"
  | "refused"
  | "send failed"
  | "stalled";

/**
 * How loudly each close is reported.
 *
 * `"silent"` means the caller has already logged the interesting part: the reason
 * a connection failed or stalled is a field on that record, and logging the close
 * again would put two records where one belongs.
 */
const LEVEL_BY_CLOSE_REASON: Record<CloseReason, "info" | "notice" | "silent"> = {
  "client disconnected": "info",
  "connection failed": "silent",
  "daemon stopping": "info",
  "handshake timed out": "notice",
  "peer left during handshake": "info",
  refused: "info",
  "send failed": "info",
  stalled: "silent",
};

/** The per-connection record. `ClientConnection` is the part a dispatcher sees. */
interface Connection extends ClientConnection {
  readonly transport: MessageTransport;
  clientName: string;
  /** Whether the peer subscribed to state. Terminal scopes are tracked separately. */
  hasStateScope: boolean;
  readonly terminalScopes: Set<TerminalID>;
  readonly attached: Set<TerminalID>;
  /** The subset of `attached` that carries a viewport and therefore gets repaints. */
  readonly rendering: Set<TerminalID>;
  /** Unanswered request ids. The dispatcher's bookkeeping, held per connection. */
  readonly inFlight: Set<RequestID>;
  /** Replies, state and attention. Never dropped; a full queue disconnects. */
  readonly control: BoundedQueue<Frame>;
  /** Coalesced repaints. Oldest-dropped, and then re-owed as a full repaint. */
  readonly output: BoundedQueue<Frame>;
  closed: boolean;
  deadline: Timer | undefined;
}

/**
 * Checks a peer's `hello` field by field.
 *
 * `decodeClientMessage` decodes to the discriminant and no further, which is the
 * right rule for requests — a malformed one deserves a `failed` reply — but the
 * handshake has no reply channel yet, so the fields are checked here and a peer
 * that sends `"2"` where a number belongs is refused rather than compared against.
 */
function validatedHello(value: unknown): Hello | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as {
    readonly protocolVersion?: unknown;
    readonly minimumSupported?: unknown;
    readonly clientName?: unknown;
  };
  const { protocolVersion, minimumSupported, clientName } = candidate;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) return undefined;
  if (typeof minimumSupported !== "number" || !Number.isInteger(minimumSupported)) return undefined;
  if (protocolVersion < 1 || minimumSupported < 1 || minimumSupported > protocolVersion) {
    return undefined;
  }
  if (typeof clientName !== "string") return undefined;
  return { protocolVersion, minimumSupported, clientName };
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const { terminals, sessions, projects, launchProfiles, log } = options;
  const dispatch =
    options.dispatch ??
    createRequestDispatch({
      sessions,
      projects,
      launchProfiles,
      terminals,
      log,
      // Bound late, to the server being built: a saved profile has no
      // `StateObserving` path to travel, because the wire is its only writer.
      announce: () =>
        server.publish(
          fullStateSnapshot({
            projects: projects.projects,
            sessions: sessions.sessions,
            launchProfiles,
            terminals,
          }),
        ),
    });
  const handshakeDeadlineMs = options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS;

  /** Peers past their handshake, keyed by the id the frame loop uses. */
  const connections = new Map<string, Connection>();
  /** Every accepted peer, including ones still handshaking. Closed on shutdown. */
  const open = new Set<Connection>();
  let counter = 0;

  /**
   * Every terminal the daemon holds, for the frame loop's per-frame drain.
   *
   * The sessions are the index because `TerminalRegistry` has no iterator: it
   * answers `get`, `inSession` and `liveCount`, and the loop needs the terminals
   * nobody is watching too — those are exactly the ones whose child blocks if
   * they stop being drained. Replace this with a registry iterator the day
   * `@janela/terminal` grows one; the loop only asks for an iterable.
   */
  const everyTerminal = function* (): Iterable<LiveTerminal> {
    for (const session of sessions.sessions) {
      yield* terminals.inSession(session.id);
    }
  };

  const frameLoop = createFrameLoop({
    terminals,
    liveTerminals: everyTerminal,
    log,
    hasRoom: (client) => {
      const connection = connections.get(client);
      return connection !== undefined && connection.output.size < connection.output.capacity;
    },
    deliver: (client, terminalID, bytes) => {
      const connection = connections.get(client);
      // `encodeOutput` copies the repaint view into the frame — one copy per
      // client, which is the price of not sharing a buffer across sockets.
      if (connection !== undefined)
        void connection.output.push(encodeOutput({ terminalID, bytes }));
    },
  });

  /**
   * Queues one control frame, or disconnects the peer that is not reading them.
   *
   * The queue's policy is `block`, which never drops — and this guard is what
   * stops it from ever engaging, because a blocked push would stall `publish` and
   * with it the caller inside `@janela/session`.
   */
  const enqueueControl = (connection: Connection, frame: Frame): void => {
    if (connection.closed) return;
    if (connection.control.size >= connection.control.capacity) {
      log.warning("client stalled", { client: connection.id, queued: connection.control.size });
      void closeConnection(connection, "stalled");
      return;
    }
    void connection.control.push(frame);
  };

  async function closeConnection(connection: Connection, reason: CloseReason): Promise<void> {
    if (connection.closed) return;
    connection.closed = true;

    if (connection.deadline !== undefined) {
      clearTimeout(connection.deadline);
      connection.deadline = undefined;
    }

    const level = LEVEL_BY_CLOSE_REASON[reason];
    if (level !== "silent") log[level](reason, { client: connection.id });

    // Finishing the queues ends both pumps; a blocked producer is released.
    connection.control.finish();
    connection.output.finish();
    frameLoop.detachAll(connection.id);

    // Detaching a viewport is not stopping a terminal (non-negotiable #7): the
    // process keeps running with the size the remaining clients negotiate.
    for (const terminalID of connection.attached) {
      try {
        terminals.get(terminalID)?.detach(connection.id);
      } catch (error) {
        log.warning("detach failed", { client: connection.id, error: errorName(error) });
      }
    }
    connection.attached.clear();
    connections.delete(connection.id);

    try {
      await connection.transport.close();
    } catch (error) {
      log.debug("transport close failed", { client: connection.id, error: errorName(error) });
    }
  }

  function createConnection(accepted: AcceptedConnection): Connection {
    counter += 1;
    const id = `c${counter}`;
    const attached = new Set<TerminalID>();
    const rendering = new Set<TerminalID>();

    const connection: Connection = {
      id,
      credential: accepted.credential,
      transport: accepted.transport,
      clientName: "",
      hasStateScope: false,
      terminalScopes: new Set<TerminalID>(),
      attached,
      rendering,
      inFlight: new Set<RequestID>(),
      control: boundedQueue<Frame>({
        capacity: CONTROL_QUEUE_CAPACITY,
        onOverflow: "block",
      }),
      output: boundedQueue<Frame>({
        capacity: OUTPUT_QUEUE_CAPACITY,
        onOverflow: "dropOldest",
        onDrop: (dropped) => {
          log.debug("output frames dropped", { client: id, dropped });
          // A delta is incremental: the frames that survive do not describe what
          // the dropped one did. Re-owe a full repaint for everything this client
          // renders, which is what makes dropping safe at all. Only the rendering
          // attachments: registering a viewportless one would ask the terminal for
          // a repaint for a client it has never heard of, and `repaintFor` throws.
          for (const terminalID of rendering) frameLoop.attach(id, terminalID);
        },
      }),
      closed: false,
      deadline: undefined,

      subscribe(scope: SubscriptionScope): void {
        if (scope.kind === "state") {
          connection.hasStateScope = true;
          return;
        }
        connection.terminalScopes.add(scope.terminalID);
      },

      attach(terminal: LiveTerminal, viewport?: GridSize): GridSize | undefined {
        attached.add(terminal.id);
        connection.terminalScopes.add(terminal.id);
        if (viewport === undefined) {
          // Input and scope, no rendering: the terminal never learns about this
          // client, so it takes no part in size negotiation and the frame loop has
          // nothing to send it (ADR 0016).
          return undefined;
        }
        const size = terminal.attach(id, viewport);
        rendering.add(terminal.id);
        frameLoop.attach(id, terminal.id);
        return size;
      },

      detach(terminalID: TerminalID): GridSize | undefined {
        frameLoop.detach(id, terminalID);
        attached.delete(terminalID);
        rendering.delete(terminalID);
        connection.terminalScopes.delete(terminalID);
        return terminals.get(terminalID)?.detach(id);
      },

      send(message: DaemonMessage): void {
        enqueueControl(connection, encodeDaemonMessage(message));
      },
    };

    return connection;
  }

  /**
   * Tells the peer why it is not welcome, then closes.
   *
   * Refusal is never fatal to the daemon and never touches a terminal: the app
   * being too new is not a reason to kill an agent mid-task (ADR 0017).
   */
  async function refuse(
    connection: Connection,
    refusal: HandshakeRefusal,
    extra?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<false> {
    log.notice("handshake refused", { client: connection.id, refusal: refusal.kind, ...extra });
    try {
      await connection.transport.send(encodeDaemonMessage({ type: "refused", refusal }));
    } catch (error) {
      log.debug("refusal not delivered", { client: connection.id, error: errorName(error) });
    }
    await closeConnection(connection, "refused");
    return false;
  }

  /** Exchanges `hello` under the deadline. False means the connection is closed. */
  async function performHandshake(
    connection: Connection,
    iterator: AsyncIterator<Frame>,
  ): Promise<boolean> {
    connection.deadline = setTimeout(() => {
      void closeConnection(connection, "handshake timed out");
    }, handshakeDeadlineMs);

    let first: IteratorResult<Frame>;
    try {
      first = await iterator.next();
    } catch {
      await closeConnection(connection, "peer left during handshake");
      return false;
    }
    if (first.done === true) {
      await closeConnection(connection, "peer left during handshake");
      return false;
    }

    if (first.value.kind !== FrameKind.Control) {
      return refuse(connection, { kind: "protocolViolation" });
    }

    let message: ClientMessage;
    try {
      message = decodeClientMessage(first.value);
    } catch {
      return refuse(connection, { kind: "protocolViolation" });
    }
    if (message.type !== "hello") {
      return refuse(connection, { kind: "protocolViolation" });
    }

    const hello = validatedHello(message.hello);
    if (hello === undefined) {
      return refuse(connection, { kind: "protocolViolation" });
    }
    if (!isCompatible(DAEMON_HELLO, hello)) {
      return refuse(
        connection,
        {
          kind: "incompatibleVersion",
          daemonMinimum: MINIMUM_SUPPORTED_VERSION,
          daemonCurrent: PROTOCOL_VERSION,
        },
        { peerVersion: hello.protocolVersion, peerMinimum: hello.minimumSupported },
      );
    }

    try {
      await connection.transport.send(encodeDaemonMessage({ type: "hello", hello: DAEMON_HELLO }));
    } catch {
      await closeConnection(connection, "peer left during handshake");
      return false;
    }
    // A peer that sent `hello` and then stopped reading is closed by the deadline,
    // which is what made the send above settle.
    if (connection.closed) return false;

    clearTimeout(connection.deadline);
    connection.deadline = undefined;
    connection.clientName = hello.clientName.slice(0, CLIENT_NAME_LOG_LIMIT);
    connections.set(connection.id, connection);

    const fields: Record<string, string | number | boolean> = {
      client: connection.id,
      clientName: connection.clientName,
      uid: connection.credential.uid,
    };
    if (connection.credential.pid !== undefined) fields["pid"] = connection.credential.pid;
    log.info("client connected", fields);
    return true;
  }

  /** Writes one queue to the socket, in order, until the queue finishes. */
  async function pump(connection: Connection, queue: BoundedQueue<Frame>): Promise<void> {
    for await (const frame of queue) {
      try {
        // One frame at a time is the ordering guarantee within a queue, and the
        // socket's own back-pressure.
        // oxlint-disable-next-line no-await-in-loop
        await connection.transport.send(frame);
      } catch {
        await closeConnection(connection, "send failed");
        return;
      }
    }
  }

  /** Reads until the peer goes away. Throws for a protocol error; the caller logs. */
  async function readLoop(connection: Connection, iterator: AsyncIterator<Frame>): Promise<void> {
    for (;;) {
      // Frames are read one at a time, in order, for as long as the peer lives:
      // there is no batch to await in parallel.
      // oxlint-disable-next-line no-await-in-loop
      const next = await iterator.next();
      if (next.done === true || connection.closed) return;
      const frame = next.value;

      if (frame.kind === FrameKind.Control) {
        const message = decodeClientMessage(frame);
        if (message.type === "hello") {
          // Terminal: the loop returns straight after this one await.
          // oxlint-disable-next-line no-await-in-loop
          await refuse(connection, { kind: "protocolViolation" });
          return;
        }
        // Not awaited: a slow request must not delay the next keystroke.
        void Promise.resolve()
          .then(() => dispatch.request(connection, message))
          .catch((error: unknown) => {
            log.warning("request failed", {
              client: connection.id,
              type: message.type,
              error: errorName(error),
            });
          })
          // A request is one of the two ways a terminal becomes live, and the
          // loop drops its timer when there is nothing left to drain.
          .finally(() => {
            frameLoop.wake();
          });
        continue;
      }

      // `decodeInput` refuses an `Output` frame from a client — a direction
      // violation is a protocol error, not something to interpret.
      const input = decodeInput(frame);
      const terminal = terminals.get(input.terminalID);
      if (terminal === undefined) {
        // Never create the terminal a frame names.
        throw new FrameError({ kind: "unknownTerminal", terminalID: input.terminalID });
      }
      try {
        dispatch.input(connection, terminal, input.bytes);
      } catch (error) {
        log.warning("input failed", { client: connection.id, error: errorName(error) });
      }
    }
  }

  /** One connection, start to finish. Never rejects: a peer cannot fail the daemon. */
  async function handle(accepted: AcceptedConnection): Promise<void> {
    const connection = createConnection(accepted);
    open.add(connection);
    const iterator = accepted.transport.incoming()[Symbol.asyncIterator]();
    let pumps: readonly Promise<void>[] = [];

    try {
      if (!(await performHandshake(connection, iterator))) return;
      pumps = [pump(connection, connection.control), pump(connection, connection.output)];
      await readLoop(connection, iterator);
      await closeConnection(connection, "client disconnected");
    } catch (error) {
      const fields: Record<string, string | number | boolean> = {
        client: connection.id,
        error: errorName(error),
      };
      if (error instanceof FrameError && error.detail.kind === "unknownTerminal") {
        fields["terminalID"] = error.detail.terminalID;
      }
      log.warning("connection failed", fields);
      await closeConnection(connection, "connection failed");
    } finally {
      await Promise.allSettled(pumps);
      open.delete(connection);
    }
  }

  const server: DaemonServer = {
    frameLoop,

    async serve(listener: ConnectionListening, signal: AbortSignal): Promise<void> {
      if (signal.aborted) {
        await listener.close();
        return;
      }

      frameLoop.start(signal);
      signal.addEventListener(
        "abort",
        () => {
          // Stops the accept loop from parking on a listener nobody will feed.
          void listener.close().catch((error: unknown) => {
            log.debug("listener close failed", { error: errorName(error) });
          });
        },
        { once: true },
      );

      const tasks = new Set<Promise<void>>();
      try {
        for await (const accepted of listener.accept()) {
          if (signal.aborted) break;
          const task = handle(accepted);
          tasks.add(task);
          void task.finally(() => {
            tasks.delete(task);
          });
        }
      } finally {
        await listener.close();
        // Closing a connection never touches a terminal; hanging up is
        // `apps/daemon`'s SIGTERM path and an explicit user choice.
        await Promise.all(
          [...open].map((connection) => closeConnection(connection, "daemon stopping")),
        );
        await Promise.allSettled(tasks);
      }
    },

    publish(update: StateUpdate): Promise<void> {
      // The other way a terminal becomes live is automation, which reaches the
      // daemon as a state change rather than a request.
      frameLoop.wake();
      // Encoded once, however many subscribers there are.
      const frame = encodeDaemonMessage({ type: "state", update });
      // Deleting from a `Map` while iterating it is defined, which matters here:
      // `enqueueControl` disconnects a peer whose control queue is full.
      for (const connection of connections.values()) {
        if (connection.hasStateScope) enqueueControl(connection, frame);
      }
      // Deliberately not awaiting anything: a client that is not reading is the
      // client's problem, and `@janela/session` is on the other end of this call.
      return Promise.resolve();
    },

    /**
     * The complete picture, not just the sessions that changed.
     *
     * `changed` is the whole current session list — that is `StateObserving`'s
     * contract — and a client merges by id, which cannot express a deletion. So
     * the other collections are composed here and the update is a full snapshot:
     * a removed session propagates by being absent from it. Composing costs one
     * pass over the sessions per announcement, which is human-rate work.
     */
    sessionsChanged(changed: readonly Session[]): Promise<void> {
      return server.publish(
        fullStateSnapshot({
          projects: projects.projects,
          sessions: changed,
          launchProfiles,
          terminals,
        }),
      );
    },

    /** Same rule as `sessionsChanged`, from the other side. */
    projectsChanged(changed: readonly Project[]): Promise<void> {
      return server.publish(
        fullStateSnapshot({
          projects: changed,
          sessions: sessions.sessions,
          launchProfiles,
          terminals,
        }),
      );
    },

    canExitWhenIdle(): boolean {
      return terminals.liveCount === 0 && connections.size === 0;
    },

    get connectionCount(): number {
      return connections.size;
    },
  };

  return server;
}
