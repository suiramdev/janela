import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";

import { log, nullLogSink, setLogSink } from "@janela/support";
import { temporaryDirectory, type TemporaryDirectory } from "@janela/test-support";

import { openRelay, type Relay, type RelayPeer } from "./relay.ts";

interface FakePeer extends RelayPeer {
  readonly sent: Uint8Array[];
  readonly closes: { readonly code: number; readonly reason: string }[];
  result: number;
}

interface Endpoint extends AsyncDisposable {
  readonly path: string;
  accepted(): Promise<Socket>;
}

const PAUSE_OBSERVATION_MS = 50;

const open: Relay[] = [];
const endpoints: Endpoint[] = [];

setLogSink(nullLogSink);

afterEach(async () => {
  for (const relay of open.splice(0)) relay.close();

  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint[Symbol.asyncDispose]()));
});

function fakePeer(result = 1): FakePeer {
  const sent: Uint8Array[] = [];
  const closes: { readonly code: number; readonly reason: string }[] = [];

  return {
    sent,
    closes,
    result,
    send(bytes) {
      sent.push(Uint8Array.from(bytes));

      return this.result;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
}

async function echoEndpoint(directory: TemporaryDirectory): Promise<Endpoint> {
  const path = directory.join("d.sock");
  const server = createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk);
    });
  });

  server.listen(path);
  await once(server, "listening");

  const endpoint: Endpoint = {
    path,
    accepted: async (): Promise<Socket> => {
      const [socket] = await once(server, "connection");

      return socket as Socket;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      server.close();
      await directory[Symbol.asyncDispose]();
    },
  };

  endpoints.push(endpoint);

  return endpoint;
}

function relayTo(peer: RelayPeer, socketPath: string, onDaemonUnreachable = (): void => {}): Relay {
  const relay = openRelay(peer, {
    socketPath,
    onDaemonUnreachable,
    log: log("protocol"),
  });

  open.push(relay);

  return relay;
}

async function until(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;

    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(1);
  }

  throw new Error(`timed out waiting for ${description}`);
}

describe("openRelay", () => {
  test("bytes cross in both directions unchanged", async () => {
    await using directory = await temporaryDirectory("gateway-relay");
    const endpoint = await echoEndpoint(directory);
    const peer = fakePeer();
    const relay = relayTo(peer, endpoint.path);

    relay.deliver(new Uint8Array([0, 0, 0, 3, 2, 104, 105]));

    await until(() => peer.sent.length > 0, "the echo");

    expect(Array.from(peer.sent[0] ?? [])).toEqual([0, 0, 0, 3, 2, 104, 105]);
  });

  test("a backpressured browser pauses the daemon rather than buffering for it", async () => {
    await using directory = await temporaryDirectory("gateway-relay");
    const endpoint = await echoEndpoint(directory);
    const peer = fakePeer(-1);
    const relay = relayTo(peer, endpoint.path);
    const accepting = endpoint.accepted();

    relay.deliver(new Uint8Array([1]));

    const connection = await accepting;
    await until(() => peer.sent.length === 1, "the first chunk");

    connection.write(Uint8Array.from([2]));
    await Bun.sleep(PAUSE_OBSERVATION_MS);

    expect(peer.sent.length).toBe(1);

    peer.result = 1;
    relay.drained();

    await until(() => peer.sent.length === 2, "the chunk held back by the pause");

    expect(Array.from(peer.sent[1] ?? [])).toEqual([2]);
  });

  test("a daemon that closes its end closes the browser normally", async () => {
    await using directory = await temporaryDirectory("gateway-relay");
    const endpoint = await echoEndpoint(directory);
    const peer = fakePeer();
    const accepting = endpoint.accepted();

    relayTo(peer, endpoint.path);

    const connection = await accepting;
    connection.end();

    await until(() => peer.closes.length > 0, "the close");

    expect(peer.closes).toEqual([{ code: 1000, reason: "daemon closed" }]);
  });

  test("no daemon at the socket asks launchd once and says so", async () => {
    await using directory = await temporaryDirectory("gateway-relay");
    const peer = fakePeer();
    let kickstarts = 0;

    relayTo(peer, directory.join("absent.sock"), () => {
      kickstarts += 1;
    });

    await until(() => peer.closes.length > 0, "the close");

    expect(kickstarts).toBe(1);
    expect(peer.closes).toEqual([{ code: 1011, reason: "daemon unreachable" }]);
  });

  test("a browser that goes away drops the socket without closing itself again", async () => {
    await using directory = await temporaryDirectory("gateway-relay");
    const endpoint = await echoEndpoint(directory);
    const peer = fakePeer();
    const accepting = endpoint.accepted();
    const relay = relayTo(peer, endpoint.path);

    const connection = await accepting;
    relay.close();

    await once(connection, "close");

    expect(peer.closes).toEqual([]);
  });
});
