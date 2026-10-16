import { createConnection, createStores, type DaemonConnection, type Stores } from "@janela/client";
import { PROTOCOL_VERSION, type HandshakeRefusal, type MessageTransport } from "@janela/protocol";
import { UserFacingError } from "@janela/support";
import { Match } from "effect";

import { SocketTransportFailure } from "./socket-transport.ts";

export const CLIENT_NAME = "janela-cli";

export const SNAPSHOT_DEADLINE_MS = 5_000;

const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

export interface LinkedDaemon {
  readonly connection: DaemonConnection;
  readonly stores: Stores;
}

export class DaemonNotRunning extends UserFacingError {
  override readonly summary = "Janela's daemon is not running.";

  constructor(socketPath: string) {
    super("daemon not running", {
      reason: `Nothing is listening on ${socketPath}.`,
      recoverySuggestion:
        "Open Janela on this Mac, or run `launchctl kickstart gui/$(id -u)/sh.janela.janelad` " +
        "from a session logged in to its desktop. The CLI never starts the daemon itself.",
    });
  }
}

export class DaemonUnreachable extends UserFacingError {
  override readonly summary = "Janela's daemon could not be reached.";

  constructor(socketPath: string, detail: string) {
    super("daemon unreachable", {
      reason: `Connecting to ${socketPath} failed: ${detail}.`,
      recoverySuggestion: "`pgrep -lx janelad` says whether a daemon is running for you.",
    });
  }
}

export class DaemonIncompatible extends UserFacingError {
  override readonly summary: string;

  constructor(refusal: HandshakeRefusal) {
    super(
      `handshake refused: ${refusal.kind}`,
      Match.value(refusal).pipe(
        Match.discriminatorsExhaustive("kind")({
          incompatibleVersion: ({ daemonMinimum, daemonCurrent }) => ({
            reason:
              `This janela speaks protocol ${PROTOCOL_VERSION}; the daemon speaks ` +
              `${daemonMinimum}–${daemonCurrent}.`,
            recoverySuggestion:
              "Use the janela that came with the installed app, or update both together. " +
              "Your terminals are still running.",
          }),
          unauthorized: () => ({
            reason: "The daemon belongs to another user.",
          }),
          protocolViolation: () => ({
            reason: "The daemon could not understand this client.",
          }),
        }),
      ),
    );

    this.summary =
      refusal.kind === "unauthorized"
        ? "The daemon refused this connection."
        : "This janela and the running daemon do not speak the same protocol.";
  }
}

function unreachable(socketPath: string, cause: unknown): UserFacingError {
  if (cause instanceof SocketTransportFailure) {
    if (cause.code !== undefined && NOT_RUNNING_CODES.has(cause.code)) {
      return new DaemonNotRunning(socketPath);
    }

    return new DaemonUnreachable(socketPath, cause.code ?? cause.name);
  }

  return new DaemonUnreachable(socketPath, cause instanceof Error ? cause.name : "unknown");
}

async function firstSnapshot(stores: Stores, deadlineMs: number): Promise<boolean> {
  if (!stores.mirror.isStale) return true;

  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), deadlineMs);
  const unsubscribe = stores.sessions.subscribe(() => {
    if (!stores.mirror.isStale) resolve(true);
  });

  const arrived = await promise;
  clearTimeout(timer);
  unsubscribe();

  return arrived;
}

export async function linkDaemon(options: {
  readonly socketPath: string;
  readonly openTransport: (socketPath: string) => Promise<MessageTransport>;
  readonly snapshotDeadlineMs?: number;
}): Promise<LinkedDaemon> {
  const { socketPath } = options;
  const stores = createStores();
  let lastFailure: unknown = undefined;

  const connection = createConnection({
    clientName: CLIENT_NAME,
    mirror: stores.mirror,
    openTransport: () =>
      options.openTransport(socketPath).catch((cause: unknown) => {
        lastFailure = cause;

        throw cause;
      }),
  });

  await connection.connect();
  const { status } = connection;

  if (status.kind === "refused") {
    await connection.disconnect();

    throw new DaemonIncompatible(status.refusal);
  }

  if (status.kind !== "connected") {
    await connection.disconnect();

    throw unreachable(socketPath, lastFailure);
  }

  if (!(await firstSnapshot(stores, options.snapshotDeadlineMs ?? SNAPSHOT_DEADLINE_MS))) {
    await connection.disconnect();

    throw new DaemonUnreachable(socketPath, "it sent no state");
  }

  return { connection, stores };
}
