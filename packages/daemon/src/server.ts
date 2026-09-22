import type { GridSize, Project, Session, TerminalID } from "@janela/core";
import type { IntegrationService } from "@janela/integrations";
import {
  FrameError,
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  UnknownTerminalFrame,
  decodeClientMessage,
  decodeInput,
  encodeDaemonMessage,
  encodeOutput,
  isCompatible,
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
  DirectoryBrowsing,
  ProjectService,
  SessionService,
  StateObserving,
} from "@janela/session";
import { boundedQueue, type BoundedQueue, type LogRecord, type Logger } from "@janela/support";
import type { LiveTerminal, TerminalRegistry } from "@janela/terminal";
import { Effect, Option, Predicate, Result, Schema } from "effect";

import {
  createRequestDispatch,
  errorName,
  fullStateSnapshot,
  type ClientConnection,
  type RequestDispatching,
} from "./dispatch.ts";
import type { PeerCredential } from "./endpoint.ts";
import { createFrameLoop, type FrameLoop } from "./frame-loop.ts";
import { createTerminalEvents } from "./terminal-events.ts";

export interface DaemonServer extends StateObserving {
  serve(listener: ConnectionListening, signal: AbortSignal): Promise<void>;
  publish(update: StateUpdate): Promise<void>;
  canExitWhenIdle(): boolean;
  readonly connectionCount: number;
  readonly frameLoop: FrameLoop;
}

export interface ConnectionListening {
  accept(): AsyncIterable<AcceptedConnection>;
  close(): Promise<void>;
}

export interface AcceptedConnection {
  readonly transport: MessageTransport;
  readonly credential: PeerCredential;
}

export interface DaemonServerOptions {
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly directories: DirectoryBrowsing;
  readonly terminals: TerminalRegistry;
  readonly integrations: IntegrationService;
  readonly log: Logger;
  readonly dispatch?: RequestDispatching;
  readonly handshakeDeadlineMs?: number;
}

type CloseReason =
  | "client disconnected"
  | "connection failed"
  | "daemon stopping"
  | "handshake timed out"
  | "peer left during handshake"
  | "refused"
  | "send failed"
  | "stalled";

interface Connection extends ClientConnection {
  readonly transport: MessageTransport;
  clientName: string;
  hasStateScope: boolean;
  readonly terminalScopes: Set<TerminalID>;
  readonly attached: Set<TerminalID>;
  readonly rendering: Set<TerminalID>;
  readonly inFlight: Set<RequestID>;
  readonly control: BoundedQueue<Frame>;
  readonly output: BoundedQueue<Frame>;
  closed: boolean;
  deadline: Timer | undefined;
}

export const HANDSHAKE_DEADLINE_MS = 5_000;

export const OUTPUT_QUEUE_CAPACITY = 32;

export const CONTROL_QUEUE_CAPACITY = 64;

export const DAEMON_CLIENT_NAME = "janelad";

const DAEMON_HELLO: Hello = {
  protocolVersion: PROTOCOL_VERSION,
  minimumSupported: MINIMUM_SUPPORTED_VERSION,
  clientName: DAEMON_CLIENT_NAME,
};

const CLIENT_NAME_LOG_LIMIT = 64;

const LEVEL_BY_CLOSE_REASON = {
  "client disconnected": "info",
  "connection failed": "silent",
  "daemon stopping": "info",
  "handshake timed out": "notice",
  "peer left during handshake": "info",
  refused: "info",
  "send failed": "info",
  stalled: "silent",
} satisfies Record<CloseReason, "info" | "notice" | "silent">;

const decodeHelloFields = Schema.decodeUnknownOption(
  Schema.Struct({
    protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    minimumSupported: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    clientName: Schema.String,
  }),
);

const decodeControlMessage = Option.liftThrowable(decodeClientMessage);

const DELIVERED = (): boolean => true;

const SEND_FAILED = (): boolean => false;

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const { terminals, sessions, projects, directories, integrations, log } = options;
  const dispatch =
    options.dispatch ??
    createRequestDispatch({
      sessions,
      projects,
      directories,
      terminals,
      integrations,
      log,
      settled: (terminal) => terminalEvents.reconcile(terminal),
    });

  const handshakeDeadlineMs = options.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS;

  const connections = new Map<string, Connection>();
  const open = new Set<Connection>();
  let counter = 0;

  const everyTerminal = function* (): Iterable<LiveTerminal> {
    for (const session of sessions.sessions) {
      yield* terminals.inSession(session.id);
    }
  };

  const enqueueControl = (connection: Connection, frame: Frame): void => {
    if (connection.closed) return;

    if (connection.control.size >= connection.control.capacity) {
      log.warning("client stalled", { client: connection.id, queued: connection.control.size });
      void closeConnection(connection, "stalled");

      return;
    }

    void connection.control.push(frame);
  };

  const broadcast = (message: DaemonMessage): void => {
    const frame = encodeDaemonMessage(message);

    for (const connection of connections.values()) {
      if (connection.hasStateScope) enqueueControl(connection, frame);
    }
  };

  const terminalEvents = createTerminalEvents({ broadcast, log });

  terminals.watch(terminalEvents);

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

      if (connection !== undefined) {
        void connection.output.push(encodeOutput({ terminalID, bytes }));
      }
    },
    settled: terminalEvents.reconcile,
  });

  async function closeConnection(connection: Connection, reason: CloseReason): Promise<void> {
    if (connection.closed) return;

    connection.closed = true;

    if (connection.deadline !== undefined) {
      clearTimeout(connection.deadline);
      connection.deadline = undefined;
    }

    const level = LEVEL_BY_CLOSE_REASON[reason];

    if (level !== "silent") log[level](reason, { client: connection.id });

    connection.control.finish();
    connection.output.finish();
    frameLoop.detachAll(connection.id);

    for (const terminalID of connection.attached) {
      const detached = Result.try({
        try: () => terminals.get(terminalID)?.detach(connection.id),
        catch: errorName,
      });

      if (Result.isFailure(detached)) {
        log.warning("detach failed", { client: connection.id, error: detached.failure });
      }
    }

    connection.attached.clear();
    connections.delete(connection.id);

    await Effect.runPromise(
      Effect.tryPromise({
        try: () => connection.transport.close(),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (cause) => {
            log.debug("transport close failed", { client: connection.id, error: errorName(cause) });
          },
        }),
      ),
    );
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

      attach(terminal: LiveTerminal, viewport: GridSize | undefined): GridSize | undefined {
        attached.add(terminal.id);
        connection.terminalScopes.add(terminal.id);

        if (viewport === undefined) return undefined;

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

  async function refuse(
    connection: Connection,
    refusal: HandshakeRefusal,
    extra: LogRecord["fields"],
  ): Promise<false> {
    log.notice("handshake refused", { client: connection.id, refusal: refusal.kind, ...extra });

    await Effect.runPromise(
      Effect.tryPromise({
        try: () => connection.transport.send(encodeDaemonMessage({ type: "refused", refusal })),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (cause) => {
            log.debug("refusal not delivered", { client: connection.id, error: errorName(cause) });
          },
        }),
      ),
    );

    await closeConnection(connection, "refused");

    return false;
  }

  async function performHandshake(
    connection: Connection,
    iterator: AsyncIterator<Frame>,
  ): Promise<boolean> {
    connection.deadline = setTimeout(() => {
      void closeConnection(connection, "handshake timed out");
    }, handshakeDeadlineMs);

    const first = Option.getOrUndefined(
      await Effect.runPromise(
        Effect.option(Effect.tryPromise({ try: () => iterator.next(), catch: (cause) => cause })),
      ),
    );

    if (first === undefined || first.done === true) {
      await closeConnection(connection, "peer left during handshake");

      return false;
    }

    if (first.value.kind !== FrameKind.Control) {
      return refuse(connection, { kind: "protocolViolation" }, undefined);
    }

    const message = Option.getOrUndefined(decodeControlMessage(first.value));

    if (message === undefined || message.type !== "hello") {
      return refuse(connection, { kind: "protocolViolation" }, undefined);
    }

    const hello = validatedHello(message.hello);

    if (hello === undefined) {
      return refuse(connection, { kind: "protocolViolation" }, undefined);
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

    const greeted = await Effect.runPromise(
      Effect.option(
        Effect.tryPromise({
          try: () =>
            connection.transport.send(encodeDaemonMessage({ type: "hello", hello: DAEMON_HELLO })),
          catch: (cause) => cause,
        }),
      ),
    );

    if (Option.isNone(greeted)) {
      await closeConnection(connection, "peer left during handshake");

      return false;
    }

    if (connection.closed) return false;

    clearTimeout(connection.deadline);
    connection.deadline = undefined;
    connection.clientName = hello.clientName.slice(0, CLIENT_NAME_LOG_LIMIT);
    connections.set(connection.id, connection);

    const { pid } = connection.credential;
    const fields = {
      client: connection.id,
      clientName: connection.clientName,
      uid: connection.credential.uid,
    };

    log.info("client connected", pid === undefined ? fields : { ...fields, pid });

    return true;
  }

  async function pump(connection: Connection, queue: BoundedQueue<Frame>): Promise<void> {
    for await (const frame of queue) {
      // oxlint-disable-next-line no-await-in-loop
      const delivered = await connection.transport.send(frame).then(DELIVERED, SEND_FAILED);

      if (delivered) continue;

      await closeConnection(connection, "send failed");

      return;
    }
  }

  async function readLoop(connection: Connection, iterator: AsyncIterator<Frame>): Promise<void> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop
      const next = await iterator.next();

      if (next.done === true || connection.closed) return;

      const frame = next.value;

      if (frame.kind === FrameKind.Control) {
        const message = decodeClientMessage(frame);

        if (message.type === "hello") {
          // oxlint-disable-next-line no-await-in-loop
          await refuse(connection, { kind: "protocolViolation" }, undefined);

          return;
        }

        void Promise.resolve()
          .then(() => dispatch.request(connection, message))
          .catch((cause: unknown) => {
            log.warning("request failed", {
              client: connection.id,
              type: message.type,
              error: errorName(cause),
            });
          })
          .finally(() => {
            frameLoop.wake();
          });

        continue;
      }

      const input = decodeInput(frame);
      const terminal = terminals.get(input.terminalID);

      if (terminal === undefined) {
        throw new FrameError({
          reason: new UnknownTerminalFrame({ terminalID: input.terminalID }),
        });
      }

      dispatch.input(connection, terminal, input.bytes);
      terminalEvents.reconcile(terminal);
    }
  }

  async function connectionFailed(connection: Connection, cause: unknown): Promise<void> {
    const base = { client: connection.id, error: errorName(cause) };
    log.warning(
      "connection failed",
      cause instanceof FrameError && Predicate.isTagged(cause.reason, "unknownTerminal")
        ? { ...base, terminalID: cause.reason.terminalID }
        : base,
    );

    await closeConnection(connection, "connection failed");
  }

  async function handle(accepted: AcceptedConnection): Promise<void> {
    const connection = createConnection(accepted);
    open.add(connection);

    const iterator = accepted.transport.incoming()[Symbol.asyncIterator]();
    let pumps: readonly Promise<void>[] = [];

    const serveConnection = async (): Promise<void> => {
      if (!(await performHandshake(connection, iterator))) return;

      pumps = [pump(connection, connection.control), pump(connection, connection.output)];
      await readLoop(connection, iterator);
      await closeConnection(connection, "client disconnected");
    };

    await Effect.runPromise(
      Effect.tryPromise({ try: serveConnection, catch: (cause) => cause }).pipe(
        Effect.catch((cause) => Effect.promise(() => connectionFailed(connection, cause))),
        Effect.ensuring(
          Effect.promise(async () => {
            await Promise.allSettled(pumps);
            open.delete(connection);
          }),
        ),
      ),
    );
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
          void listener.close().catch((cause: unknown) => {
            log.debug("listener close failed", { error: errorName(cause) });
          });
        },
        { once: true },
      );

      const tasks = new Set<Promise<void>>();

      await Effect.runPromise(
        Effect.tryPromise({
          try: async () => {
            for await (const accepted of listener.accept()) {
              if (signal.aborted) break;

              const task = handle(accepted);
              tasks.add(task);
              void task.finally(() => {
                tasks.delete(task);
              });
            }
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              await listener.close();
              await Promise.all(
                [...open].map((connection) => closeConnection(connection, "daemon stopping")),
              );

              await Promise.allSettled(tasks);
            }),
          ),
        ),
      );
    },

    publish(update: StateUpdate): Promise<void> {
      frameLoop.wake();
      broadcast({ type: "state", update });

      return Promise.resolve();
    },

    sessionsChanged(changed: readonly Session[]): Promise<void> {
      return server.publish(
        fullStateSnapshot({
          projects: projects.projects,
          sessions: changed,
          terminals,
        }),
      );
    },

    projectsChanged(changed: readonly Project[]): Promise<void> {
      return server.publish(
        fullStateSnapshot({
          projects: changed,
          sessions: sessions.sessions,
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

function validatedHello(value: Hello): Hello | undefined {
  const decoded = Option.getOrUndefined(decodeHelloFields(value));

  if (decoded === undefined) return undefined;

  if (decoded.minimumSupported > decoded.protocolVersion) return undefined;

  return decoded;
}
