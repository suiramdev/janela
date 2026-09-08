import { describe, expect, test } from "bun:test";

import type { TerminalID } from "@janela/core";

import { FRAME_INTERVAL_MS, createFrameLoop, type FrameLoop } from "./frame-loop.ts";
import {
  fakeRegistry,
  fakeTerminal,
  recordingLogger,
  type FakeTerminal,
  type Recorded,
} from "./test-fakes.ts";

const terminalID = (): TerminalID => crypto.randomUUID() as TerminalID;

interface Delivery {
  readonly client: string;
  readonly terminalID: TerminalID;
  readonly text: string;
}

interface Harness {
  readonly loop: FrameLoop;
  readonly deliveries: Delivery[];
  readonly records: Recorded[];
  /** Clients whose output queue is full, as the server's `hasRoom` would report. */
  readonly withoutRoom: Set<string>;
  /** How often the loop asked for the terminals — one per frame it ran. */
  readonly frames: { count: number };
}

function harness(
  terminals: readonly FakeTerminal[],
  /** What the daemon's enumeration yields. Defaults to everything registered. */
  enumerated: readonly FakeTerminal[] = terminals,
): Harness {
  const deliveries: Delivery[] = [];
  const withoutRoom = new Set<string>();
  const frames = { count: 0 };
  const { logger, records } = recordingLogger();
  const decoder = new TextDecoder();

  return {
    loop: createFrameLoop({
      terminals: fakeRegistry(terminals),
      liveTerminals: () => {
        frames.count += 1;
        return enumerated;
      },
      hasRoom: (client) => !withoutRoom.has(client),
      deliver: (client, id, bytes) => {
        deliveries.push({ client, terminalID: id, text: decoder.decode(bytes) });
      },
      log: logger,
    }),
    deliveries,
    records,
    withoutRoom,
    frames,
  };
}

describe("the frame loop", () => {
  test("the interval is one frame at 120 Hz", () => {
    expect(FRAME_INTERVAL_MS).toBe(8);
    expect(harness([]).loop.intervalMs).toBe(FRAME_INTERVAL_MS);
  });

  test("an attached client is owed a full repaint first, then deltas", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([terminal]);

    loop.attach("c1", terminal.id);
    loop.tick();
    loop.tick();

    expect(terminal.fullRepaintCalls).toEqual(["c1"]);
    expect(terminal.repaintCalls).toEqual(["c1"]);
    expect(deliveries.map((delivery) => delivery.text)).toEqual(["F", "d"]);
    expect(deliveries[0]?.terminalID).toBe(terminal.id);
  });

  test("one encode per attached client per tick, in attach order", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop } = harness([terminal]);

    for (const client of ["a", "b", "c"]) loop.attach(client, terminal.id);
    loop.tick();
    loop.tick();

    expect(terminal.fullRepaintCalls).toEqual(["a", "b", "c"]);
    expect(terminal.repaintCalls).toEqual(["a", "b", "c"]);
    expect(terminal.attached.size).toBe(0);
    expect(terminal.sendCalls).toEqual([]);
    expect(terminal.stopCalls.count).toBe(0);
  });

  test("an empty repaint sends nothing", () => {
    const terminal = fakeTerminal(terminalID(), {
      full: new Uint8Array(0),
      delta: new Uint8Array(0),
    });
    const { loop, deliveries } = harness([terminal]);

    loop.attach("c1", terminal.id);
    loop.tick();
    loop.tick();

    expect(terminal.fullRepaintCalls).toHaveLength(1);
    expect(deliveries).toEqual([]);
  });

  test("a client with no room costs no encode, and recovers with a full repaint", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries, withoutRoom } = harness([terminal]);

    loop.attach("slow", terminal.id);
    loop.tick();
    expect(deliveries.map((delivery) => delivery.text)).toEqual(["F"]);

    withoutRoom.add("slow");
    for (let index = 0; index < 5; index += 1) loop.tick();
    expect(terminal.repaintCalls).toEqual([]);
    expect(terminal.fullRepaintCalls).toEqual(["slow"]);

    withoutRoom.delete("slow");
    loop.tick();
    expect(terminal.fullRepaintCalls).toEqual(["slow", "slow"]);
    expect(deliveries.map((delivery) => delivery.text)).toEqual(["F", "F"]);
  });

  test("a stalled client does not stop another client's frames", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries, withoutRoom } = harness([terminal]);

    loop.attach("fast", terminal.id);
    loop.attach("slow", terminal.id);
    withoutRoom.add("slow");

    for (let index = 0; index < 3; index += 1) loop.tick();

    expect(deliveries.filter((delivery) => delivery.client === "fast")).toHaveLength(3);
    expect(deliveries.filter((delivery) => delivery.client === "slow")).toHaveLength(0);
    expect(terminal.repaintCalls).toEqual(["fast", "fast"]);
  });

  test("a terminal that left the registry is dropped, and the others keep ticking", () => {
    const gone = fakeTerminal(terminalID());
    const alive = fakeTerminal(terminalID());
    const { loop, deliveries, records } = harness([alive]);

    loop.attach("c1", gone.id);
    loop.attach("c1", alive.id);
    loop.tick();
    loop.tick();

    expect(deliveries.every((delivery) => delivery.terminalID === alive.id)).toBe(true);
    expect(alive.fullRepaintCalls).toEqual(["c1"]);
    expect(records).toEqual([]);
  });

  test("a repaint that throws detaches that terminal and is logged with its id", () => {
    const broken = fakeTerminal(terminalID(), { throwOnRepaint: new RangeError("pty gone") });
    const alive = fakeTerminal(terminalID());
    const { loop, deliveries, records } = harness([broken, alive]);

    loop.attach("c1", broken.id);
    loop.attach("c2", broken.id);
    loop.attach("c1", alive.id);
    loop.tick();

    const failures = records.filter((record) => record.message === "repaint failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.level).toBe("warning");
    expect(failures[0]?.fields?.["terminalID"]).toBe(broken.id);
    expect(failures[0]?.fields?.["error"]).toBe("RangeError");

    loop.tick();
    expect(deliveries.every((delivery) => delivery.terminalID === alive.id)).toBe(true);
    expect(alive.repaintCalls).toEqual(["c1"]);
  });

  test("detach stops that client's frames and leaves the others alone", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([terminal]);

    loop.attach("a", terminal.id);
    loop.attach("b", terminal.id);
    loop.tick();
    loop.detach("a", terminal.id);
    loop.tick();

    expect(deliveries.filter((delivery) => delivery.client === "a")).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.client === "b")).toHaveLength(2);
  });

  test("detachAll removes a gone connection from every terminal", () => {
    const first = fakeTerminal(terminalID());
    const second = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([first, second]);

    loop.attach("gone", first.id);
    loop.attach("gone", second.id);
    loop.attach("stays", first.id);
    loop.detachAll("gone");
    loop.tick();

    expect(deliveries.map((delivery) => delivery.client)).toEqual(["stays"]);
  });

  test("every live terminal is fed once per frame, watched or not", () => {
    const watched = fakeTerminal(terminalID());
    const unwatched = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([watched, unwatched]);

    loop.attach("c1", watched.id);
    loop.tick();
    loop.tick();

    // The rule this exists for: a terminal nobody has open still has to consume,
    // or its child blocks in `write(2)` at the PTY's high-water mark.
    expect(unwatched.drainCalls.count).toBe(2);
    expect(watched.drainCalls.count).toBe(2);
    // Fed, but never encoded: nobody is watching it.
    expect(unwatched.repaintCalls).toEqual([]);
    expect(unwatched.fullRepaintCalls).toEqual([]);
    expect(deliveries.map((delivery) => delivery.terminalID)).toEqual([watched.id, watched.id]);
  });

  test("one feed per terminal per frame, however many clients are attached", () => {
    const terminal = fakeTerminal(terminalID());
    const { loop } = harness([terminal]);

    loop.attach("a", terminal.id);
    loop.attach("b", terminal.id);
    loop.attach("c", terminal.id);
    loop.tick();

    // One drain, one feed, N encodes — the reason `drain()` is not part of
    // `repaintFor()` at all.
    expect(terminal.drainCalls.count).toBe(1);
    expect(terminal.fullRepaintCalls).toEqual(["a", "b", "c"]);
  });

  test("a terminal with no process is not fed", () => {
    const idle = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const { loop } = harness([idle]);

    loop.tick();

    expect(idle.drainCalls.count).toBe(0);
  });

  test("a watched terminal the enumeration missed is fed, and still only once", () => {
    const terminal = fakeTerminal(terminalID());
    // Registered, watched, and absent from the enumeration: the client's screen
    // has to keep moving anyway.
    const { loop, deliveries } = harness([terminal], []);

    loop.attach("c1", terminal.id);
    loop.tick();

    expect(terminal.drainCalls.count).toBe(1);
    expect(deliveries).toHaveLength(1);
  });

  test("the feed happens before the encode", () => {
    const terminal = fakeTerminal(terminalID());
    const order: string[] = [];
    const observed: FakeTerminal = {
      ...terminal,
      drain: () => {
        order.push("drain");
        terminal.drain();
      },
      fullRepaintFor: (client) => {
        order.push("encode");
        return terminal.fullRepaintFor(client);
      },
    };
    // Both paths must order the same way: this one is fed by the encode pass,
    // because the enumeration does not yield it.
    const { loop } = harness([observed], []);
    const enumerated = harness([observed]);

    loop.attach("c1", observed.id);
    loop.tick();
    enumerated.loop.attach("c2", observed.id);
    enumerated.loop.tick();

    // A repaint encoded before the feed would be a frame behind, every frame.
    expect(order).toEqual(["drain", "encode", "drain", "encode"]);
  });

  test("a drain that throws costs that terminal only, and is logged once", () => {
    const lost = fakeTerminal(terminalID(), { throwOnDrain: new Error("read failed") });
    const healthy = fakeTerminal(terminalID());
    const { loop, deliveries, records } = harness([lost, healthy]);

    loop.attach("c1", lost.id);
    loop.attach("c1", healthy.id);
    loop.tick();
    loop.tick();

    // #17's `readFailed` escaping would end the frame for every other terminal —
    // and, from a timer callback, take the loop with it.
    expect(healthy.drainCalls.count).toBe(2);
    expect(deliveries.map((delivery) => delivery.terminalID)).toEqual([healthy.id, healthy.id]);
    expect(lost.fullRepaintCalls).toEqual([]);
    const failures = records.filter((record) => record.message === "drain failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields?.["terminalID"]).toBe(lost.id);
  });

  test("a terminal that comes back is owed a full repaint, not a delta", () => {
    const terminal = fakeTerminal(terminalID());
    let failuresLeft = 2;
    const flaky: FakeTerminal = {
      ...terminal,
      drain: () => {
        terminal.drainCalls.count += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("read failed");
        }
      },
    };
    const { loop, deliveries } = harness([flaky]);

    loop.attach("c1", flaky.id);
    loop.tick();
    loop.tick();
    expect(deliveries).toEqual([]);

    // A `restart` re-establishes the descriptor. Resuming with a delta against a
    // screen the client never saw is the corruption a full repaint avoids.
    loop.tick();
    expect(deliveries.map((delivery) => delivery.text)).toEqual(["F"]);
    expect(terminal.repaintCalls).toEqual([]);
  });

  test("a live terminal keeps the interval running with nobody attached", async () => {
    const terminal = fakeTerminal(terminalID());
    const { loop } = harness([terminal]);
    const controller = new AbortController();

    // Real time, deliberately: the claim is about `setInterval`, which fake
    // timers would assert about the mock rather than about the loop.
    loop.start(controller.signal);
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(terminal.drainCalls.count).toBeGreaterThan(1);

    controller.abort();
    const fed = terminal.drainCalls.count;
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(terminal.drainCalls.count).toBe(fed);
  });

  test("nothing live and nobody attached disarms the interval, and wake arms it", async () => {
    const idle = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const { loop, frames } = harness([idle]);
    const controller = new AbortController();

    loop.start(controller.signal);
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    // One frame to discover there is nothing to do, then no wakeups at all:
    // forty configured-but-idle terminals cost nothing (non-negotiable #5).
    expect(frames.count).toBe(1);

    loop.wake();
    await Bun.sleep(FRAME_INTERVAL_MS * 2);
    expect(frames.count).toBeGreaterThan(1);
    controller.abort();
  });

  test("an attach arms the interval and abort stops it", async () => {
    const idle = fakeTerminal(terminalID(), { state: { kind: "idle" } });
    const { loop, deliveries } = harness([idle]);
    const controller = new AbortController();

    loop.start(controller.signal);
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toEqual([]);

    loop.attach("c1", idle.id);
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    const delivered = deliveries.length;
    expect(delivered).toBeGreaterThan(0);

    controller.abort();
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toHaveLength(delivered);
  });

  test("the last detach stops the encodes but not the feed", async () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([terminal]);
    const controller = new AbortController();

    loop.start(controller.signal);
    loop.attach("c1", terminal.id);
    await Bun.sleep(FRAME_INTERVAL_MS * 3);
    loop.detach("c1", terminal.id);
    const delivered = deliveries.length;
    const fed = terminal.drainCalls.count;

    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toHaveLength(delivered);
    // Closing the last window does not stop the terminal consuming.
    expect(terminal.drainCalls.count).toBeGreaterThan(fed);
    controller.abort();
  });
});
