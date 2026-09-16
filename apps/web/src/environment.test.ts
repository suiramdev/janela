import { describe, expect, test } from "bun:test";

import {
  FrameKind,
  MINIMUM_SUPPORTED_VERSION,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeDaemonMessage,
  type Frame,
  type MessageTransport,
} from "@janela/protocol";

import { CLIENT_NAME, webEnvironment } from "./environment.ts";

interface FakeTransport extends MessageTransport {
  readonly sent: Frame[];
  readonly opened: number;
}

interface TransportFixture {
  readonly transport: FakeTransport;
  open(): Promise<MessageTransport>;
}

const DAEMON_HELLO = encodeDaemonMessage({
  type: "hello",
  hello: {
    protocolVersion: PROTOCOL_VERSION,
    minimumSupported: MINIMUM_SUPPORTED_VERSION,
    clientName: "janelad",
  },
});

function fakeTransport(): TransportFixture {
  const sent: Frame[] = [];
  let opened = 0;
  let ended: (() => void) | undefined;

  const transport: FakeTransport = {
    sent,
    get opened(): number {
      return opened;
    },
    async *incoming(): AsyncGenerator<Frame> {
      yield { kind: FrameKind.Control, payload: DAEMON_HELLO.payload.slice() };

      await new Promise<void>((resolve) => {
        ended = resolve;
      });
    },
    send(frame: Frame): Promise<void> {
      sent.push({ kind: frame.kind, payload: frame.payload.slice() });

      return Promise.resolve();
    },
    close(): Promise<void> {
      ended?.();

      return Promise.resolve();
    },
  };

  return {
    transport,
    open: () => {
      opened += 1;

      return Promise.resolve(transport);
    },
  };
}

describe("webEnvironment", () => {
  test("construction opens nothing; start opens once and says who it is", async () => {
    const fake = fakeTransport();
    const environment = webEnvironment({ openTransport: fake.open });

    expect(fake.transport.opened).toBe(0);

    await environment.start();

    expect(fake.transport.opened).toBe(1);

    const hello = fake.transport.sent[0];

    expect(hello).toBeDefined();

    if (hello !== undefined) {
      const message = decodeClientMessage(hello);

      expect(message.type).toBe("hello");

      if (message.type === "hello") expect(message.hello.clientName).toBe(CLIENT_NAME);
    }

    expect(environment.connection.status).toEqual({ kind: "connected" });

    await environment.connection.disconnect();
  });
});
