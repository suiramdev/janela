import { describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

import { SocketDirectoryUnsafe } from "@janela/daemon";
import { nullLogSink, setLogSink, log } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";
import { Effect, Result } from "effect";

import { bindDaemonSocket, SOCKET_FILE_MODE, type BindOutcome } from "./socket.ts";

setLogSink(nullLogSink);

const silent = log("protocol");

function ownUid(): number {
  const uid = process.getuid?.();

  if (uid === undefined) throw new Error("no uid on this platform");

  return uid;
}

function closed(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  server.close(() => resolve());

  return promise;
}

function armedServer(): Server {
  const server = createServer();

  server.on("connection", (socket) => socket.destroy());

  return server;
}

function answers(path: string): Promise<boolean> {
  const probe = connect(path);
  const { promise, resolve } = Promise.withResolvers<boolean>();

  probe.once("connect", () => {
    probe.destroy();
    resolve(true);
  });
  probe.once("error", () => resolve(false));

  return promise;
}

async function refusalOf(binding: Promise<BindOutcome>): Promise<Error | undefined> {
  const outcome = await Effect.runPromise(
    Effect.result(Effect.tryPromise({ try: () => binding, catch: (cause: unknown) => cause })),
  );

  if (Result.isSuccess(outcome)) return undefined;

  return outcome.failure instanceof Error ? outcome.failure : undefined;
}

describe("bindDaemonSocket", () => {
  test("creates the run directory 0700 and binds inside it", async () => {
    await using directory = await temporaryDirectory("socket");
    const path = join(directory.path, "run", "janelad.sock");
    const server = armedServer();
    const outcome = await bindDaemonSocket({ server, path, ownUid: ownUid(), log: silent });

    expect(outcome.kind).toBe("bound");
    expect((await stat(join(directory.path, "run"))).mode & 0o777).toBe(0o700);
    expect(await answers(path)).toBe(true);

    await closed(server);
  });

  test("the socket file is 0600 — SockPathMode's replacement now the plist declares no socket", async () => {
    await using directory = await temporaryDirectory("socket");
    const path = join(directory.path, "run", "janelad.sock");
    const server = armedServer();

    await bindDaemonSocket({ server, path, ownUid: ownUid(), log: silent });

    expect((await stat(path)).mode & 0o777).toBe(SOCKET_FILE_MODE);

    await closed(server);
  });

  test("an existing world-readable run directory refuses to serve, whatever mode we asked for", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");

    await mkdir(run, { recursive: true });
    await chmod(run, 0o755);

    const refusal = await refusalOf(
      bindDaemonSocket({
        server: armedServer(),
        path: join(run, "janelad.sock"),
        ownUid: ownUid(),
        log: silent,
      }),
    );

    expect(refusal).toBeInstanceOf(SocketDirectoryUnsafe);
  });

  test("a leftover file on the path is unlinked and rebound, socket or not", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");

    await mkdir(run, { recursive: true, mode: 0o700 });

    const path = join(run, "janelad.sock");

    await writeFile(path, "leftover");

    const server = armedServer();
    const outcome = await bindDaemonSocket({ server, path, ownUid: ownUid(), log: silent });

    expect(outcome.kind).toBe("bound");
    expect(await answers(path)).toBe(true);

    await closed(server);
  });

  test("a live incumbent yields `already-serving` and keeps accepting, so its terminals are untouched", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");

    await mkdir(run, { recursive: true, mode: 0o700 });

    const path = join(run, "janelad.sock");
    const incumbent = createServer();
    const up = Promise.withResolvers<void>();

    incumbent.listen(path, up.resolve);

    await up.promise;

    const outcome = await bindDaemonSocket({
      server: armedServer(),
      path,
      ownUid: ownUid(),
      log: silent,
    });

    expect(outcome.kind).toBe("already-serving");
    expect(await answers(path)).toBe(true);

    await closed(incumbent);
  });

  test("a foreign-owned run directory refuses to serve", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");

    await mkdir(run, { recursive: true, mode: 0o700 });

    const refusal = await refusalOf(
      bindDaemonSocket({
        server: armedServer(),
        path: join(run, "janelad.sock"),
        ownUid: ownUid() + 1,
        log: silent,
      }),
    );

    expect(refusal).toBeInstanceOf(SocketDirectoryUnsafe);
  });

  test("refuses a server with no connection handler, before touching the path", async () => {
    await using directory = await temporaryDirectory("socket");
    const path = join(directory.path, "run", "janelad.sock");
    const refusal = await refusalOf(
      bindDaemonSocket({ server: createServer(), path, ownUid: ownUid(), log: silent }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(await answers(path)).toBe(false);
  });
});
