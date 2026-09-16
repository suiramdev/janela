import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { daemonIsListening, lineSplitter } from "./dev.ts";

const cleanups: (() => Promise<void>)[] = [];

async function socketDirectory(): Promise<string> {
  return await mkdtemp("/tmp/janela-dev-");
}

async function listening(path: string): Promise<Server> {
  const server = createServer();
  const bound = Promise.withResolvers<void>();

  server.once("error", bound.reject);
  server.listen(path, bound.resolve);
  await bound.promise;

  cleanups.push(async () => {
    const closed = Promise.withResolvers<void>();

    server.close(() => closed.resolve());
    await closed.promise;
  });

  return server;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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
