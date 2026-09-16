import { describe, expect, test } from "bun:test";

import {
  FrameError,
  FrameKind,
  TruncatedFrame,
  encodeFrame,
  type Frame,
  type MessageTransport,
} from "@janela/protocol";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { Effect, Result } from "effect";

import {
  BridgeRefused,
  CONNECTION_HEADER,
  openTauriTransport,
  type BridgeInvoke,
} from "./transport.ts";

interface Invocation {
  readonly command: string;
  readonly args: unknown;
  readonly options: unknown;
}

interface FakeBridge {
  readonly invoke: BridgeInvoke;
  readonly invocations: readonly Invocation[];
  deliver(bytes: Uint8Array): void;
  fail(error: Error): void;
  failWith(reason: string): void;
}

interface RawRefusal {
  readonly reason: string;
}

type BridgeAnswer = number | ArrayBuffer | undefined;

type BridgeAnswering = (
  command: string,
  args: InvokeArgs | undefined,
  options: InvokeOptions | undefined,
) => Promise<BridgeAnswer>;

const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x80, 0xc3, 0x28]);

const outputFrame: Frame = { kind: FrameKind.Output, payload: NOT_UTF8 };

const REFUSING_BRIDGE: BridgeInvoke = async (): Promise<never> => {
  throw "daemon-unavailable";
};

function bridgeInvoke(answer: BridgeAnswering): BridgeInvoke {
  return <Answer>(
    command: string,
    args: InvokeArgs | undefined = undefined,
    options: InvokeOptions | undefined = undefined,
  ): Promise<Answer> => answer(command, args, options) as Promise<Answer>;
}

async function drain(transport: MessageTransport): Promise<Result.Result<void, unknown>> {
  return await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: async () => {
          for await (const frame of transport.incoming()) void frame;
        },
        catch: (cause) => cause,
      }),
    ),
  );
}

function fakeBridge(connectionID = 7): FakeBridge {
  const invocations: Invocation[] = [];
  const pending: Array<Uint8Array | Error | RawRefusal> = [];

  const invoke = bridgeInvoke(async (command, args, options) => {
    invocations.push({ command, args, options });

    if (command === "bridge_connect") return connectionID;

    if (command !== "bridge_receive") return undefined;

    const next = pending.shift();

    if (next === undefined) throw new Error("the test queued no response");

    if (next instanceof Error) throw next;

    if (!(next instanceof Uint8Array)) throw next.reason;

    return next.slice().buffer;
  });

  return {
    invoke,
    invocations,
    deliver: (bytes) => pending.push(bytes),
    fail: (error) => pending.push(error),
    failWith: (reason) => pending.push({ reason }),
  };
}

describe("openTauriTransport", () => {
  test("connects once and reports nothing else on the way up", async () => {
    const bridge = fakeBridge();

    await openTauriTransport(bridge.invoke);

    expect(bridge.invocations.map((call) => call.command)).toEqual(["bridge_connect"]);
  });

  test("the shell's refusal reason survives as the error's name", async () => {
    const thrown = await openTauriTransport(REFUSING_BRIDGE).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(BridgeRefused);

    if (thrown instanceof Error) expect(thrown.name).toBe("daemon-unavailable");
  });

  test("a severed bridge reports `bridge-stalled` rather than `unknown`", async () => {
    const bridge = fakeBridge();
    bridge.failWith("bridge-stalled");
    const transport = await openTauriTransport(bridge.invoke);

    const drained = await drain(transport);
    const thrown = Result.isFailure(drained) ? drained.failure : undefined;

    expect(thrown).toBeInstanceOf(BridgeRefused);

    if (thrown instanceof Error) expect(thrown.name).toBe("bridge-stalled");
  });

  test("sends the encoded frame as the whole body, with the id in a header", async () => {
    const bridge = fakeBridge(42);
    const transport = await openTauriTransport(bridge.invoke);

    await transport.send(outputFrame);

    const [, send] = bridge.invocations;

    expect(send?.command).toBe("bridge_send");
    expect(send?.args).toEqual(encodeFrame(outputFrame));
    expect(send?.options).toEqual({ headers: { [CONNECTION_HEADER]: "42" } });
  });

  test("an invalid-UTF-8 payload crosses outward byte-identical", async () => {
    const bridge = fakeBridge();
    const transport = await openTauriTransport(bridge.invoke);

    await transport.send(outputFrame);

    const body = bridge.invocations[1]?.args;

    expect(body).toBeInstanceOf(Uint8Array);

    if (body instanceof Uint8Array) expect(body.subarray(5)).toEqual(NOT_UTF8);
  });

  test("an invalid-UTF-8 payload crosses inward byte-identical", async () => {
    const bridge = fakeBridge();
    bridge.deliver(encodeFrame(outputFrame));
    bridge.deliver(new Uint8Array(0));
    const transport = await openTauriTransport(bridge.invoke);

    const received: Frame[] = [];

    for await (const frame of transport.incoming()) {
      received.push({ kind: frame.kind, payload: new Uint8Array(frame.payload) });
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe(FrameKind.Output);
    expect(received[0]?.payload).toEqual(NOT_UTF8);
  });

  test("a frame split across two responses reassembles", async () => {
    const encoded = encodeFrame({ kind: FrameKind.Control, payload: new Uint8Array([1, 2, 3, 4]) });
    const bridge = fakeBridge();
    bridge.deliver(encoded.subarray(0, 3));
    bridge.deliver(encoded.subarray(3));
    bridge.deliver(new Uint8Array(0));
    const transport = await openTauriTransport(bridge.invoke);

    const received: Frame[] = [];

    for await (const frame of transport.incoming()) {
      received.push({ kind: frame.kind, payload: new Uint8Array(frame.payload) });
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("a zero-byte response ends the sequence cleanly", async () => {
    const bridge = fakeBridge();
    bridge.deliver(new Uint8Array(0));
    const transport = await openTauriTransport(bridge.invoke);

    const received: Frame[] = [];

    for await (const frame of transport.incoming()) received.push(frame);

    expect(received).toEqual([]);
  });

  test("a zero-byte response mid-frame throws `truncated`", async () => {
    const encoded = encodeFrame({ kind: FrameKind.Output, payload: new Uint8Array([9, 9, 9]) });
    const bridge = fakeBridge();
    bridge.deliver(encoded.subarray(0, 6));
    bridge.deliver(new Uint8Array(0));
    const transport = await openTauriTransport(bridge.invoke);

    const drained = await drain(transport);
    const thrown = Result.isFailure(drained) ? drained.failure : undefined;

    expect(thrown).toBeInstanceOf(FrameError);

    if (thrown instanceof FrameError) {
      expect(thrown.reason).toEqual(new TruncatedFrame({ expected: 8, received: 6 }));
    }
  });

  test("an invoke rejection propagates, so the client treats it as a lost connection", async () => {
    const bridge = fakeBridge();
    bridge.fail(new Error("bridge-stalled"));
    const transport = await openTauriTransport(bridge.invoke);

    const drained = await drain(transport);
    const thrown = Result.isFailure(drained) ? drained.failure : undefined;

    expect(thrown).toBeInstanceOf(Error);
  });

  test("close is idempotent", async () => {
    const bridge = fakeBridge();
    const transport = await openTauriTransport(bridge.invoke);

    await transport.close();
    await transport.close();

    const closes = bridge.invocations.filter((call) => call.command === "bridge_close");

    expect(closes).toHaveLength(1);
    expect(closes[0]?.args).toEqual({ id: 7 });
  });

  test("close swallows a rejection, because the caller has already stopped caring", async () => {
    const bridge = bridgeInvoke(async (command) => {
      if (command === "bridge_connect") return 1;

      throw new Error("already gone");
    });

    const transport = await openTauriTransport(bridge);

    expect(transport.close()).resolves.toBeUndefined();
  });
});
