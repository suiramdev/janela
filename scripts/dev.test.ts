import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";

import {
  GATEWAY_PORT_BASE,
  ISOLATED_ROOT,
  PORT_SPAN,
  daemonIsListening,
  freePortFrom,
  isolatedHome,
  lineSplitter,
  portIsFree,
  preferredGatewayPort,
  seedDotfiles,
  socketPathUnder,
} from "./dev.ts";

const SUN_PATH_LIMIT = 104;

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

describe("the isolated home", () => {
  test("is the same for the same checkout and different for another", () => {
    const first = isolatedHome("/Users/someone/worktrees/one/janela");

    expect(isolatedHome("/Users/someone/worktrees/one/janela")).toBe(first);
    expect(isolatedHome("/Users/someone/worktrees/two/janela")).not.toBe(first);
    expect(first.startsWith(`${ISOLATED_ROOT}/`)).toBe(true);
  });

  test("a trailing slash names the same checkout", () => {
    expect(isolatedHome("/Users/someone/janela/")).toBe(isolatedHome("/Users/someone/janela"));
  });

  test("its socket path fits sun_path however deep the checkout is", () => {
    const deep = `/Users/${"a".repeat(200)}/janela`;

    expect(Buffer.byteLength(socketPathUnder(isolatedHome(deep)))).toBeLessThanOrEqual(
      SUN_PATH_LIMIT,
    );
  });
});

describe("the preferred gateway port", () => {
  test("is deterministic and never the shared gateway's 7411", () => {
    const root = "/Users/someone/worktrees/one/janela";
    const port = preferredGatewayPort(root);

    expect(preferredGatewayPort(root)).toBe(port);
    expect(port).toBeGreaterThanOrEqual(GATEWAY_PORT_BASE);
    expect(port).toBeLessThan(GATEWAY_PORT_BASE + PORT_SPAN);
  });
});

async function boundPort(): Promise<number> {
  const server = createServer();
  const bound = Promise.withResolvers<void>();

  server.once("error", bound.reject);
  server.listen(0, "127.0.0.1", bound.resolve);
  await bound.promise;
  cleanups.push(async () => {
    const closed = Promise.withResolvers<void>();

    server.close(() => closed.resolve());
    await closed.promise;
  });

  return (server.address() as AddressInfo).port;
}

describe("the free port search", () => {
  test("a bound port is not free", async () => {
    const port = await boundPort();

    expect(await portIsFree(port)).toBe(false);
  });

  test("skips a bound port and stops at the end of its window", async () => {
    const port = await boundPort();
    const found = await freePortFrom(port, 10);

    expect(found).toBeDefined();
    expect(found).toBeGreaterThan(port);
    expect(found).toBeLessThan(port + 10);
    expect(await freePortFrom(port, 1)).toBeUndefined();
  });
});

async function homes(): Promise<{ real: string; isolated: string }> {
  const real = await mkdtemp("/tmp/janela-dev-real-");
  const isolated = await mkdtemp("/tmp/janela-dev-iso-");
  cleanups.push(() => rm(real, { recursive: true, force: true }));
  cleanups.push(() => rm(isolated, { recursive: true, force: true }));
  await writeFile(join(real, ".zshrc"), "export SHELL_RC=1\n");
  await writeFile(join(real, ".gitconfig"), "[user]\n\tname = someone\n");
  await mkdir(join(real, ".ssh"));
  await mkdir(join(real, ".claude"));

  return { real, isolated };
}

describe("seeding the isolated home's dotfiles", () => {
  test("links the rc files that exist and nothing else", async () => {
    const { real, isolated } = await homes();

    expect(await seedDotfiles(real, isolated)).toEqual([".zshrc", ".gitconfig"]);
    expect(await readlink(join(isolated, ".zshrc"))).toBe(join(real, ".zshrc"));
    expect(await readlink(join(isolated, ".gitconfig"))).toBe(join(real, ".gitconfig"));
    expect((await readdir(isolated)).toSorted()).toEqual([".gitconfig", ".zshrc"]);
  });

  test("a second run links nothing new", async () => {
    const { real, isolated } = await homes();
    await seedDotfiles(real, isolated);

    expect(await seedDotfiles(real, isolated)).toEqual([]);
  });

  test("a file already in the isolated home is left alone", async () => {
    const { real, isolated } = await homes();
    await writeFile(join(isolated, ".zshrc"), "mine\n");

    expect(await seedDotfiles(real, isolated)).toEqual([".gitconfig"]);
    expect(await Bun.file(join(isolated, ".zshrc")).text()).toBe("mine\n");
  });
});
