import { describe, expect, test } from "bun:test";

import { FrameError, FrameKind, encodeFrame, type Frame } from "@janela/protocol";

import {
  BridgeRefused,
  CONNECTION_HEADER,
  openTauriTransport,
  type BridgeInvoke,
} from "./transport.ts";

/** One invoke the fake saw, with whatever crossed the boundary. */
interface Invocation {
  readonly command: string;
  readonly args: unknown;
  readonly options: unknown;
}

interface FakeBridge {
  readonly invoke: BridgeInvoke;
  readonly invocations: readonly Invocation[];
  /** Queues one `bridge_receive` response. A zero-length one means "socket ended". */
  deliver(bytes: Uint8Array): void;
  /** Makes the next `bridge_receive` reject. */
  fail(error: Error): void;
  /** Makes the next `bridge_receive` reject with a raw string, as Tauri does. */
  failWith(reason: string): void;
}

/** A raw-string rejection, which is what Tauri produces from a `Err(String)`. */
interface RawRefusal {
  readonly reason: string;
}

function fakeBridge(connectionID = 7): FakeBridge {
  const invocations: Invocation[] = [];
  const pending: Array<Uint8Array | Error | RawRefusal> = [];

  const invoke = (async (command: string, args?: unknown, options?: unknown): Promise<unknown> => {
    invocations.push({ command, args, options });
    if (command === "bridge_connect") return connectionID;
    if (command !== "bridge_receive") return undefined;

    const next = pending.shift();
    if (next === undefined) throw new Error("the test queued no response");
    if (next instanceof Error) throw next;
    if (!(next instanceof Uint8Array)) throw next.reason;
    // A copy, because Tauri hands the WebView a fresh ArrayBuffer and a test that
    // shares a buffer with the transport can hide an aliasing bug.
    return next.slice().buffer;
  }) as unknown as BridgeInvoke;

  return {
    invoke,
    invocations,
    deliver: (bytes) => pending.push(bytes),
    fail: (error) => pending.push(error),
    failWith: (reason) => pending.push({ reason }),
  };
}

/** Bytes that are not valid UTF-8: a lone continuation byte and a truncated pair. */
const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x80, 0xc3, 0x28]);

const outputFrame: Frame = { kind: FrameKind.Output, payload: NOT_UTF8 };

describe("openTauriTransport", () => {
  test("connects once and reports nothing else on the way up", async () => {
    const bridge = fakeBridge();

    await openTauriTransport(bridge.invoke);

    expect(bridge.invocations.map((call) => call.command)).toEqual(["bridge_connect"]);
  });

  test("the shell's refusal reason survives as the error's name", async () => {
    const refusing: BridgeInvoke = (async (): Promise<never> => {
      // Tauri rejects with the raw string the Rust side returned, not an Error.
      throw "daemon-unavailable";
    }) as unknown as BridgeInvoke;

    const thrown = await openTauriTransport(refusing).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Every logger in @janela/client reduces a thrown value to `error.name`, so
    // an unwrapped rejection is logged as "unknown" and the reason is lost
    // exactly where a bug report needs it.
    expect(thrown).toBeInstanceOf(BridgeRefused);
    if (thrown instanceof Error) expect(thrown.name).toBe("daemon-unavailable");
  });

  test("a severed bridge reports `bridge-stalled` rather than `unknown`", async () => {
    const bridge = fakeBridge();
    bridge.failWith("bridge-stalled");
    const transport = await openTauriTransport(bridge.invoke);

    const thrown = await (async () => {
      try {
        for await (const frame of transport.incoming()) void frame;
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(BridgeRefused);
    if (thrown instanceof Error) expect(thrown.name).toBe("bridge-stalled");
  });

  test("sends the encoded frame as the whole body, with the id in a header", async () => {
    const bridge = fakeBridge(42);
    const transport = await openTauriTransport(bridge.invoke);

    await transport.send(outputFrame);

    const [, send] = bridge.invocations;
    expect(send?.command).toBe("bridge_send");
    // The body is the frame itself. A wrapper object here would put every repaint
    // inside JSON and cost a base64 pass per frame.
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
    // Three bytes: less than the five-byte header, so the split is mid-header too.
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

    // A client quitting is not an error, and `createConnection` reads a finished
    // sequence as a lost connection and retries.
    expect(received).toEqual([]);
  });

  test("a zero-byte response mid-frame throws `truncated`", async () => {
    const encoded = encodeFrame({ kind: FrameKind.Output, payload: new Uint8Array([9, 9, 9]) });
    const bridge = fakeBridge();
    bridge.deliver(encoded.subarray(0, 6));
    bridge.deliver(new Uint8Array(0));
    const transport = await openTauriTransport(bridge.invoke);

    const thrown = await (async () => {
      try {
        for await (const frame of transport.incoming()) void frame;
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    // A peer that vanished mid-write is a dirty close, and the distinction is the
    // whole of `MessageTransport`'s "finishes cleanly, throws when it does not".
    expect(thrown).toBeInstanceOf(FrameError);
    if (thrown instanceof FrameError) expect(thrown.detail.kind).toBe("truncated");
  });

  test("an invoke rejection propagates, so the client treats it as a lost connection", async () => {
    const bridge = fakeBridge();
    bridge.fail(new Error("bridge-stalled"));
    const transport = await openTauriTransport(bridge.invoke);

    const thrown = await (async () => {
      try {
        for await (const frame of transport.incoming()) void frame;
        return undefined;
      } catch (error) {
        return error;
      }
    })();

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
    const bridge: BridgeInvoke = (async (command: string): Promise<unknown> => {
      if (command === "bridge_connect") return 1;
      throw new Error("already gone");
    }) as unknown as BridgeInvoke;
    const transport = await openTauriTransport(bridge);

    expect(transport.close()).resolves.toBeUndefined();
  });
});
