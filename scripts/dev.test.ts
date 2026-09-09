import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { daemonIsListening, lineSplitter } from "./dev.ts";

/**
 * `/tmp`, never `$TMPDIR`: `sun_path` is 104 bytes and macOS hands out
 * `/var/folders/…` paths long enough to spend most of that before a filename.
 */
async function socketDirectory(): Promise<string> {
  return await mkdtemp("/tmp/janela-dev-");
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function listening(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return server;
}

describe("the dev script's liveness probe", () => {
  test("answers for a socket nothing is bound to", async () => {
    const directory = await socketDirectory();
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    expect(await daemonIsListening(join(directory, "janelad.sock"))).toBe(false);
  });

  test("answers for a daemon that is accepting connections", async () => {
    const directory = await socketDirectory();
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "janelad.sock");
    await listening(path);

    expect(await daemonIsListening(path)).toBe(true);
  });

  test("a leftover file at the socket path is not alive", async () => {
    // The reason this is a connect rather than an `existsSync`: a killed daemon
    // leaves its address behind, and testing for the file would make `bun run dev`
    // refuse to start a daemon forever — while the daemon's own bind path takes a
    // dead incumbent's address over happily (`packages/daemon`'s endpoint).
    const directory = await socketDirectory();
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "janelad.sock");
    await Bun.write(path, "leftover");

    expect(existsSync(path)).toBe(true);
    expect(await daemonIsListening(path)).toBe(false);
  });
});

describe("the dev script's line splitter", () => {
  test("reassembles a record split across chunks", () => {
    const splitter = lineSplitter();
    const encoder = new TextEncoder();

    expect(splitter.push(encoder.encode('{"message":"lis'))).toEqual([]);
    expect(splitter.push(encoder.encode('tening"}\n{"message":"ready"}\n'))).toEqual([
      '{"message":"listening"}',
      '{"message":"ready"}',
    ]);
    expect(splitter.flush()).toEqual([]);
  });

  test("a partial line at end of stream is still printed", () => {
    const splitter = lineSplitter();

    splitter.push(new TextEncoder().encode("daemon died mid-"));

    expect(splitter.flush()).toEqual(["daemon died mid-"]);
    expect(splitter.flush()).toEqual([]);
  });

  test("a producer that never writes a newline does not grow the buffer forever", () => {
    const splitter = lineSplitter(8);

    expect(splitter.push(new TextEncoder().encode("123456789"))).toEqual(["123456789"]);
    expect(splitter.flush()).toEqual([]);
  });
});
