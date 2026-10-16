import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";

import {
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  encodeDaemonMessage,
  encodeFrame,
  type DaemonMessage,
} from "@janela/protocol";
import { temporaryDirectory } from "@janela/test-support";

import { DaemonIncompatible, DaemonNotRunning, linkDaemon } from "./daemon-link.ts";
import { exitStatusFor, EXIT_STATUS } from "./exit-status.ts";
import { openSocketTransport } from "./socket-transport.ts";

async function daemonSaying(path: string, messages: readonly DaemonMessage[]): Promise<Server> {
  const server = createServer((socket) => {
    socket.once("data", () => {
      for (const message of messages) socket.write(encodeFrame(encodeDaemonMessage(message)));
    });
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(path, resolve);
  await promise;

  return server;
}

async function closed(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

describe("linkDaemon", () => {
  test("no daemon is a stated failure with its own exit status, and nothing is started", async () => {
    await using directory = await temporaryDirectory("cli-link");
    const socketPath = directory.join("janelad.sock");

    const failure = await linkDaemon({ socketPath, openTransport: openSocketTransport }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(DaemonNotRunning);
    expect(failure instanceof DaemonNotRunning ? failure.reason : "").toContain(socketPath);
    expect(failure instanceof DaemonNotRunning ? exitStatusFor(failure) : 0).toBe(
      EXIT_STATUS.unreachable,
    );
  });

  test("a daemon that refuses our version is incompatible, not absent", async () => {
    await using directory = await temporaryDirectory("cli-link");
    const socketPath = directory.join("janelad.sock");
    const server = await daemonSaying(socketPath, [
      {
        type: "refused",
        refusal: {
          kind: "incompatibleVersion",
          daemonMinimum: PROTOCOL_VERSION + 1,
          daemonCurrent: PROTOCOL_VERSION + 1,
        },
      },
    ]);

    const failure = await linkDaemon({ socketPath, openTransport: openSocketTransport }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(DaemonIncompatible);
    expect(failure instanceof DaemonIncompatible ? exitStatusFor(failure) : 0).toBe(
      EXIT_STATUS.incompatible,
    );

    await closed(server);
  });

  test("a daemon that greets and sends its state yields a filled mirror", async () => {
    await using directory = await temporaryDirectory("cli-link");
    const socketPath = directory.join("janelad.sock");
    const server = await daemonSaying(socketPath, [
      {
        type: "hello",
        hello: {
          protocolVersion: PROTOCOL_VERSION,
          minimumSupported: MINIMUM_SUPPORTED_VERSION,
          clientName: "janelad",
        },
      },
      {
        type: "state",
        update: { projects: [], sessions: [], terminalStates: {}, isFullSnapshot: true },
      },
    ]);

    const linked = await linkDaemon({ socketPath, openTransport: openSocketTransport });

    expect(linked.connection.status.kind).toBe("connected");
    expect(linked.stores.mirror.isStale).toBe(false);

    await linked.connection.disconnect();
    await closed(server);
  });
});
