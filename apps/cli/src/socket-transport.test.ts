import { describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";

import {
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeClientMessage,
  encodeFrame,
  type Frame,
} from "@janela/protocol";
import { temporaryDirectory } from "@janela/test-support";

import { SocketTransportFailure, openSocketTransport } from "./socket-transport.ts";

const hello: Frame = encodeClientMessage({
  type: "hello",
  hello: {
    protocolVersion: PROTOCOL_VERSION,
    minimumSupported: MINIMUM_SUPPORTED_VERSION,
    clientName: "janela-cli-test",
  },
});

async function listening(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
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

describe("openSocketTransport", () => {
  test("no socket at the path is daemon-unavailable, with the system's reason", async () => {
    await using directory = await temporaryDirectory("cli-transport");

    const failure = await openSocketTransport(directory.join("absent.sock")).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(SocketTransportFailure);
    expect(failure instanceof SocketTransportFailure ? failure.name : "").toBe(
      "daemon-unavailable",
    );

    expect(failure instanceof SocketTransportFailure ? failure.code : "").toBe("ENOENT");
  });

  test("a frame sent arrives whole, and a frame received is decoded even when split", async () => {
    await using directory = await temporaryDirectory("cli-transport");
    const path = directory.join("d.sock");
    const bytes = Buffer.from(encodeFrame(hello));
    const received: Uint8Array[] = [];
    const arrived = Promise.withResolvers<void>();

    const server = await listening(path, (socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(new Uint8Array(chunk));

        if (Buffer.concat(received).byteLength >= bytes.byteLength) arrived.resolve();
      });
    });

    let client: Socket | undefined;
    const transport = await openSocketTransport(path, (target) => {
      client = connect({ path: target });

      return client;
    });

    client?.emit("data", bytes.subarray(0, 3));
    client?.emit("data", bytes.subarray(3));

    const iterator = transport.incoming()[Symbol.asyncIterator]();
    await transport.send(hello);
    const echoed = await iterator.next();

    expect(echoed.done).toBe(false);
    expect(echoed.done === true ? undefined : decodeClientMessage(echoed.value)).toEqual(
      decodeClientMessage(hello),
    );

    await arrived.promise;

    expect(Buffer.concat(received)).toEqual(bytes);

    await transport.close();
    await closed(server);
  });

  test("the daemon hanging up ends the incoming stream", async () => {
    await using directory = await temporaryDirectory("cli-transport");
    const path = directory.join("d.sock");

    const server = await listening(path, (socket) => {
      socket.end();
    });

    const transport = await openSocketTransport(path);
    const next = await transport.incoming()[Symbol.asyncIterator]().next();

    expect(next.done).toBe(true);

    await closed(server);
  });

  test("sending after close is refused rather than silently dropped", async () => {
    await using directory = await temporaryDirectory("cli-transport");
    const path = directory.join("d.sock");
    const server = await listening(path, () => {});

    const transport = await openSocketTransport(path);
    await transport.close();

    await expect(transport.send(hello)).rejects.toBeInstanceOf(SocketTransportFailure);

    await closed(server);
  });
});
