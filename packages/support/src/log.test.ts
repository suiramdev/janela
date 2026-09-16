import { afterEach, describe, expect, test } from "bun:test";

import { log, nullLogSink, setLogSink, type LogRecord } from "./log.ts";

function recording() {
  const records: LogRecord[] = [];

  return { sink: { write: (record: LogRecord) => records.push(record) }, records };
}

afterEach(() => {
  setLogSink(nullLogSink);
});

describe("log", () => {
  test("records are dropped before a sink is installed", () => {
    expect(() => log("protocol").info("nobody is listening")).not.toThrow();
  });

  test("a record reaches the installed sink with its level, category and message", () => {
    const { sink, records } = recording();

    setLogSink(sink);

    log("session").notice("session created");

    expect(records).toEqual([{ level: "notice", category: "session", message: "session created" }]);
  });

  test("fields are carried through, and absent fields leave no key", () => {
    const { sink, records } = recording();

    setLogSink(sink);

    const logger = log("git");

    logger.debug("git finished", { subcommand: "worktree", exitCode: 0 });
    logger.debug("git finished");

    expect(records[0]?.fields).toEqual({ subcommand: "worktree", exitCode: 0 });
    expect(records[1]).not.toHaveProperty("fields");
  });

  test("every level reaches the sink under its own name", () => {
    const { sink, records } = recording();

    setLogSink(sink);

    const logger = log("pty");

    logger.debug("d");
    logger.info("i");
    logger.notice("n");
    logger.warning("w");
    logger.error("e");

    expect(records.map((record) => record.level)).toEqual([
      "debug",
      "info",
      "notice",
      "warning",
      "error",
    ]);
  });

  test("a logger held from before `setLogSink` writes to the new sink", () => {
    const logger = log("app");
    const { sink, records } = recording();

    setLogSink(sink);

    logger.info("late");

    expect(records).toHaveLength(1);
  });

  test("nullLogSink discards", () => {
    setLogSink(nullLogSink);

    expect(() => log("db").error("nowhere")).not.toThrow();
  });
});
