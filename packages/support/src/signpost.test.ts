import { afterEach, describe, expect, test } from "bun:test";

import { begin, setSignpostSink, type SignpostRecord } from "./signpost.ts";

function recording() {
  const records: SignpostRecord[] = [];

  return { sink: { record: (record: SignpostRecord) => records.push(record) }, records };
}

afterEach(() => {
  setSignpostSink(undefined);
});

describe("signposts", () => {
  test("an interval records its name, id, fields and a duration", () => {
    const { sink, records } = recording();

    setSignpostSink(sink);

    const mark = begin("repaint", "terminal-1");

    mark.end({ client: "a", bytes: 42, full: false });

    expect(records).toHaveLength(1);

    const record = records[0];

    expect(record?.name).toBe("repaint");
    expect(record?.id).toBe("terminal-1");
    expect(record?.fields).toEqual({ client: "a", bytes: 42, full: false });
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("an interval with neither id nor fields leaves no keys behind", () => {
    const { sink, records } = recording();

    setSignpostSink(sink);

    begin("connect").end();

    expect(records[0]).not.toHaveProperty("id");
    expect(records[0]).not.toHaveProperty("fields");
  });

  test("ending twice records once", () => {
    const { sink, records } = recording();

    setSignpostSink(sink);

    const mark = begin("attach", "terminal-1");

    mark.end({ bytes: 1 });
    mark.end({ bytes: 2 });

    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toEqual({ bytes: 1 });
  });

  test("with no sink, every interval is the same unobserved object", () => {
    const first = begin("repaint", "terminal-1");
    const second = begin("attach");

    expect(first).toBe(second);
    expect(first.observed).toBe(false);
    expect(() => first.end({ bytes: 1 })).not.toThrow();
  });

  test("a sink installed mid-interval is not consulted by that interval", () => {
    const mark = begin("git");
    const { sink, records } = recording();

    setSignpostSink(sink);

    mark.end();

    expect(records).toEqual([]);
  });

  test("removing the sink stops recording", () => {
    const { sink, records } = recording();

    setSignpostSink(sink);
    begin("forge").end();
    setSignpostSink(undefined);

    begin("forge").end();

    expect(records).toHaveLength(1);
  });
});
