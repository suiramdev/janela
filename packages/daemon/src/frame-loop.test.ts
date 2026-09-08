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
}

function harness(terminals: readonly FakeTerminal[]): Harness {
  const deliveries: Delivery[] = [];
  const withoutRoom = new Set<string>();
  const { logger, records } = recordingLogger();
  const decoder = new TextDecoder();

  return {
    loop: createFrameLoop({
      terminals: fakeRegistry(terminals),
      hasRoom: (client) => !withoutRoom.has(client),
      deliver: (client, id, bytes) => {
        deliveries.push({ client, terminalID: id, text: decoder.decode(bytes) });
      },
      log: logger,
    }),
    deliveries,
    records,
    withoutRoom,
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

  test("an idle daemon schedules no wakeups, and an attach arms the interval", async () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([terminal]);
    const controller = new AbortController();

    loop.start(controller.signal);
    // Nothing attached: the interval must not exist, so no frame can run.
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toEqual([]);

    loop.attach("c1", terminal.id);
    // Real time, deliberately: the claim under test is that `setInterval` is
    // armed by `attach` and disarmed by `abort`, which fake timers would assert
    // about the mock rather than about the loop.
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    const delivered = deliveries.length;
    expect(delivered).toBeGreaterThan(0);

    controller.abort();
    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toHaveLength(delivered);
  });

  test("the last detach disarms the interval", async () => {
    const terminal = fakeTerminal(terminalID());
    const { loop, deliveries } = harness([terminal]);
    const controller = new AbortController();

    loop.start(controller.signal);
    loop.attach("c1", terminal.id);
    await Bun.sleep(FRAME_INTERVAL_MS * 3);
    loop.detach("c1", terminal.id);
    const delivered = deliveries.length;

    await Bun.sleep(FRAME_INTERVAL_MS * 4);
    expect(deliveries).toHaveLength(delivered);
    controller.abort();
  });
});
