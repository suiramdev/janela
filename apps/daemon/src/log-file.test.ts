import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log, nullLogSink, setLogSink } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";
import { Schema } from "effect";

import { FIELD_VALUE_LIMIT, installDaemonLogSink, openLogFile, type LogFile } from "./log-file.ts";

interface OpenedLogFile extends LogFile, Disposable {}

interface InstalledSink extends Disposable {
  readonly captured: readonly string[];
  lines(): readonly string[];
}

const RECENT_MS = 5_000;

const WrittenRecord = Schema.Struct({
  time: Schema.String,
  level: Schema.String,
  category: Schema.String,
  message: Schema.String,
  fields: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  ),
});

const parseWrittenRecord = Schema.decodeUnknownSync(Schema.fromJsonString(WrittenRecord));

setLogSink(nullLogSink);

function openFor(path: string, limitBytes: number | undefined): OpenedLogFile {
  const file = limitBytes === undefined ? openLogFile(path) : openLogFile(path, limitBytes);

  return { ...file, [Symbol.dispose]: () => file.close() };
}

function install(path: string, mirrorToStderr: boolean): InstalledSink {
  const captured: string[] = [];
  const sink = installDaemonLogSink({
    path,
    mirrorToStderr,
    writeStderr: (written) => captured.push(written),
  });

  return {
    captured,
    lines: () =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((written) => written !== ""),
    [Symbol.dispose]: () => {
      sink.close();
      setLogSink(nullLogSink);
    },
  };
}

function line(marker: string, bytes = 30): string {
  return `${marker.padEnd(bytes - 1, ".")}\n`;
}

describe("the log file", () => {
  test("creates the directory and the file it was given, 0700 and 0600", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using file = openFor(path, undefined);

    expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
  });

  test("a line is on disk when write returns, before any close", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using file = openFor(path, undefined);

    file.write("a\n");

    expect(readFileSync(path, "utf8")).toBe("a\n");
  });

  test("rotates before the line that would cross the limit, keeping exactly one previous file", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using file = openFor(path, 100);

    for (const marker of ["one", "two", "three", "four"]) file.write(line(marker));

    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("one") + line("two") + line("three"));
    expect(readFileSync(path, "utf8")).toBe(line("four"));

    for (const marker of ["five", "six", "seven", "eight"]) file.write(line(marker));

    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("four") + line("five") + line("six"));
    expect(readFileSync(path, "utf8")).toBe(line("seven") + line("eight"));
  });

  test("an existing file counts toward the limit, so restarts cannot append past the bound", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, line("old", 90), { mode: 0o600 });

    using file = openFor(path, 100);

    file.write(line("new"));

    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("old", 90));
    expect(readFileSync(path, "utf8")).toBe(line("new"));
  });

  test("a line larger than the whole limit still lands rather than rotating forever", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using file = openFor(path, 10);

    file.write(line("huge", 40));

    expect(readFileSync(path, "utf8")).toBe(line("huge", 40));
    expect(() => statSync(`${path}.1`)).toThrow();
  });
});

describe("the daemon's sink", () => {
  test("writes the record as one JSON line, time first, and nothing else", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using sink = install(path, false);

    log("session").info("session created", { session: "s1" });

    const written = sink.lines();

    expect(written).toHaveLength(1);

    const record = parseWrittenRecord(written[0] ?? "");

    expect(written[0]).toBe(
      JSON.stringify({
        time: record.time,
        level: "info",
        category: "session",
        message: "session created",
        fields: { session: "s1" },
      }),
    );

    expect(Date.now() - Date.parse(record.time)).toBeLessThan(RECENT_MS);
    expect(sink.captured).toEqual([]);
  });

  test("mirrors to stderr in the foreground, and a record with no fields carries no fields key", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using sink = install(path, true);

    log("protocol").info("listening", undefined);

    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0]).toBe(`${sink.lines()[0] ?? ""}\n`);
    expect(sink.lines()[0]).not.toContain("fields");
  });

  test("falls back to stderr when the file cannot be opened, naming the errno and not the path", async () => {
    await using directory = await temporaryDirectory("log-file");

    writeFileSync(join(directory.path, "not-a-directory"), "");

    const path = join(directory.path, "not-a-directory", "janelad.log");
    using sink = install(path, false);
    const first = parseWrittenRecord(sink.captured[0] ?? "");

    expect(first.message).toBe("log file unavailable");
    expect(first.fields).toEqual({ error: "EEXIST" });

    log("app").info("still logging", undefined);

    expect(sink.captured).toHaveLength(2);
    expect(sink.captured[1]).toContain('"message":"still logging"');
  });

  test("a body-shaped field never reaches disk verbatim", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using sink = install(path, false);
    const body = `total 8\n\u001b[1;32mREADME.md\u001b[0m\n${"x".repeat(4_000)}\nTAIL-9f3c`;

    log("terminal").info("output", { body, terminal: "t1", bytes: 4_096 });

    const written = sink.lines();

    expect(written).toHaveLength(1);

    const record = parseWrittenRecord(written[0] ?? "");

    expect(record.fields).toEqual({
      body: `<${body.length} characters elided>`,
      terminal: "t1",
      bytes: 4_096,
    });

    const raw = readFileSync(path, "utf8");

    expect(raw).not.toContain("README.md");
    expect(raw).not.toContain("TAIL-9f3c");
    expect(raw).not.toContain("xxxx");
    expect(raw).not.toContain("\u001b");
  });

  test("the field limit is 120 characters: that length survives, one more becomes a length", async () => {
    expect(FIELD_VALUE_LIMIT).toBe(120);

    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using sink = install(path, false);
    const atLimit = "a".repeat(FIELD_VALUE_LIMIT);
    const pastLimit = "b".repeat(FIELD_VALUE_LIMIT + 1);

    log("git").info("worktree added", { atLimit, pastLimit });

    const record = parseWrittenRecord(sink.lines()[0] ?? "");

    expect(record.fields).toEqual({
      atLimit,
      pastLimit: `<${FIELD_VALUE_LIMIT + 1} characters elided>`,
    });

    expect(readFileSync(path, "utf8")).not.toContain("bbbb");
  });

  test("a message shaped like a body is elided too", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    using sink = install(path, false);

    log("pty").debug("SECRET-9f3c\nsecond line", undefined);

    expect(sink.lines()[0]).toContain('"message":"<23 characters elided>"');
  });
});
