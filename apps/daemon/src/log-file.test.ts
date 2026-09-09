import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log, nullLogSink, setLogSink } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";

import { installDaemonLogSink, openLogFile, type LogFile } from "./log-file.ts";

setLogSink(nullLogSink);

/** Descriptors a test opened, so a failing assertion cannot leak one. */
const opened: LogFile[] = [];
const installed: { close(): void }[] = [];

afterEach(() => {
  setLogSink(nullLogSink);
  for (const file of opened) file.close();
  for (const sink of installed) sink.close();
  opened.length = 0;
  installed.length = 0;
});

function openFor(path: string, limitBytes?: number): LogFile {
  const file = limitBytes === undefined ? openLogFile(path) : openLogFile(path, limitBytes);
  opened.push(file);
  return file;
}

/** `\n` included, so a count is a count of bytes on disk. */
function line(marker: string, bytes = 30): string {
  return `${marker.padEnd(bytes - 1, ".")}\n`;
}

describe("the log file", () => {
  test("creates the directory and the file, 0700 and 0600", async () => {
    await using directory = await temporaryDirectory("log-file");
    // The directory deliberately does not exist: on a fresh machine
    // `~/Library/Logs/sh.janela.Janela` is created by whichever process logs first.
    const path = join(directory.path, "logs", "janelad.log");

    openFor(path);

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a line is on disk when write returns", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const file = openFor(path);

    file.write("a\n");

    // Before `close()`: a daemon that crashes must not take its last records with
    // it, which is the whole reason the writes are synchronous.
    expect(readFileSync(path, "utf8")).toBe("a\n");
  });

  test("rotates before the line that would cross the limit, keeping one previous file", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const file = openFor(path, 100);

    for (const marker of ["one", "two", "three", "four"]) file.write(line(marker));

    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("one") + line("two") + line("three"));
    expect(readFileSync(path, "utf8")).toBe(line("four"));

    for (const marker of ["five", "six", "seven", "eight"]) file.write(line(marker));

    // One previous file, overwritten: the bound on disk is twice the limit and
    // stays there however long the daemon runs.
    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("four") + line("five") + line("six"));
    expect(readFileSync(path, "utf8")).toBe(line("seven") + line("eight"));
  });

  test("an existing file counts toward the limit", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    // A daemon restarted every hour must not append past the bound one restart at
    // a time, so the size on disk is what the limit is measured against.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, line("old", 90), { mode: 0o600 });

    const file = openFor(path, 100);
    file.write(line("new"));

    expect(readFileSync(`${path}.1`, "utf8")).toBe(line("old", 90));
    expect(readFileSync(path, "utf8")).toBe(line("new"));
  });

  test("a line larger than the limit still lands", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const file = openFor(path, 10);

    file.write(line("huge", 40));

    // Rotating an empty file would rotate forever and drop every record.
    expect(readFileSync(path, "utf8")).toBe(line("huge", 40));
    expect(() => statSync(`${path}.1`)).toThrow();
  });
});

describe("the daemon's sink", () => {
  function install(
    path: string,
    mirrorToStderr: boolean,
  ): { readonly captured: string[]; readonly lines: () => string[] } {
    const captured: string[] = [];
    installed.push(
      installDaemonLogSink({
        path,
        mirrorToStderr,
        writeStderr: (written) => captured.push(written),
      }),
    );
    return {
      captured,
      lines: () =>
        readFileSync(path, "utf8")
          .split("\n")
          .filter((written) => written !== ""),
    };
  }

  test("writes the record as one JSON line with a time", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const sink = install(path, false);

    log("session").info("session created", { session: "s1" });

    const written = sink.lines();
    expect(written).toHaveLength(1);
    const record = JSON.parse(written[0] ?? "") as Record<string, unknown>;
    expect(record).toEqual({
      time: expect.any(String),
      level: "info",
      category: "session",
      message: "session created",
      fields: { session: "s1" },
    });
    expect(Date.now() - Date.parse(String(record["time"]))).toBeLessThan(5_000);
    // Not the foreground: stderr is `/dev/null` under launchd and writing there
    // twice is noise in a developer's pipe.
    expect(sink.captured).toEqual([]);
  });

  test("mirrors to stderr in the foreground", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const sink = install(path, true);

    log("protocol").info("listening");

    expect(sink.captured).toHaveLength(1);
    expect(sink.captured[0]).toBe(`${sink.lines()[0] ?? ""}\n`);
  });

  test("falls back to stderr when the file cannot be opened, and says so", async () => {
    await using directory = await temporaryDirectory("log-file");
    // A regular file where a directory has to be: `ENOTDIR`, and the closest
    // real-world equivalent of a `~/Library/Logs` a daemon may not write.
    writeFileSync(join(directory.path, "not-a-directory"), "");
    const path = join(directory.path, "not-a-directory", "janelad.log");
    const sink = install(path, false);

    const first = JSON.parse(sink.captured[0] ?? "") as Record<string, unknown>;
    expect(first["message"]).toBe("log file unavailable");
    // `EEXIST` is what `mkdir -p` answers when the directory's path is a file.
    expect(first["fields"]).toEqual({ error: "EEXIST" });

    log("app").info("still logging");

    // Not the foreground, and still on stderr: with no file there is nowhere else,
    // and a daemon that cannot log must still start.
    expect(sink.captured).toHaveLength(2);
    expect(sink.captured[1]).toContain('"message":"still logging"');
  });

  test("a body-shaped field never reaches disk verbatim", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const sink = install(path, false);

    // What a leak would look like: terminal output. Multi-line, escape-bearing,
    // long — and the daemon has no call that logs one today, which is exactly why
    // this pins the sink rather than a call site (non-negotiable 11).
    const body = `total 8\n\u001b[1;32mREADME.md\u001b[0m\n${"x".repeat(4_000)}\nTAIL-9f3c`;
    log("terminal").info("output", { body, terminal: "t1", bytes: 4_096 });

    const written = sink.lines();
    expect(written).toHaveLength(1);
    const record = JSON.parse(written[0] ?? "") as Record<string, unknown>;
    expect(record["fields"]).toEqual({
      body: `<${body.length} characters elided>`,
      terminal: "t1",
      bytes: 4_096,
    });
    // Nothing of it, not the first line and not the last: a reader who greps this
    // file for their own output finds a length, and `tail` cannot be driven by an
    // escape sequence that came out of somebody's shell.
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("README.md");
    expect(raw).not.toContain("TAIL-9f3c");
    expect(raw).not.toContain("xxxx");
    expect(raw).not.toContain("\u001b");
  });

  test("a message shaped like a body is elided too", async () => {
    await using directory = await temporaryDirectory("log-file");
    const path = join(directory.path, "logs", "janelad.log");
    const sink = install(path, false);

    // Every `message` in the daemon is a literal, so this can only happen by
    // someone passing content where a label belongs. It still must not land.
    log("pty").debug("SECRET-9f3c\nsecond line");

    expect(sink.lines()[0]).toContain('"message":"<23 characters elided>"');
  });
});
