import { describe, expect, test } from "bun:test";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";

import { SocketDirectoryUnsafe } from "@janela/daemon";
import { nullLogSink, setLogSink, log } from "@janela/support";
import { temporaryDirectory } from "@janela/test-support";

import { bindDaemonSocket, SOCKET_FILE_MODE } from "./socket.ts";

setLogSink(nullLogSink);
const silent = log("protocol");

function ownUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("no uid on this platform");
  return uid;
}

/** Closes a server and waits for it, so the next test's path is free. */
function closed(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

/** Whether anything answers on `path`. The client's own liveness question. */
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

describe("bindDaemonSocket", () => {
  test("creates the run directory 0700 and binds inside it", async () => {
    await using directory = await temporaryDirectory("socket");
    const path = join(directory.path, "run", "janelad.sock");

    const outcome = await bindDaemonSocket({ path, ownUid: ownUid(), log: silent });

    expect(outcome.kind).toBe("bound");
    expect((await stat(join(directory.path, "run"))).mode & 0o777).toBe(0o700);
    expect(await answers(path)).toBe(true);
    if (outcome.kind === "bound") await closed(outcome.server);
  });

  test("the socket file is 0600 — SockPathMode's replacement", async () => {
    await using directory = await temporaryDirectory("socket");
    const path = join(directory.path, "run", "janelad.sock");

    const outcome = await bindDaemonSocket({ path, ownUid: ownUid(), log: silent });

    expect((await stat(path)).mode & 0o777).toBe(SOCKET_FILE_MODE);
    if (outcome.kind === "bound") await closed(outcome.server);
  });

  test("a world-readable run directory refuses to serve", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");
    await mkdir(run, { recursive: true });
    await chmod(run, 0o755);

    // Creating it 0700 is not the same as it *being* 0700: the socket is a
    // capability, so a directory anyone can enter is a refusal, not a warning.
    const thrown = await bindDaemonSocket({
      path: join(run, "janelad.sock"),
      ownUid: ownUid(),
      log: silent,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
  });

  test("a stale socket file left by a killed daemon is unlinked and rebound", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");
    await mkdir(run, { recursive: true, mode: 0o700 });
    const path = join(run, "janelad.sock");
    // Not a socket at all, which is the worst case of the same problem: `bind`
    // fails with EADDRINUSE against any existing file.
    await writeFile(path, "leftover");

    const outcome = await bindDaemonSocket({ path, ownUid: ownUid(), log: silent });

    expect(outcome.kind).toBe("bound");
    expect(await answers(path)).toBe(true);
    if (outcome.kind === "bound") await closed(outcome.server);
  });

  test("a live incumbent yields `already-serving` and keeps accepting", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");
    await mkdir(run, { recursive: true, mode: 0o700 });
    const path = join(run, "janelad.sock");

    const incumbent = createServer();
    const up = Promise.withResolvers<void>();
    incumbent.listen(path, up.resolve);
    await up.promise;

    const outcome = await bindDaemonSocket({ path, ownUid: ownUid(), log: silent });

    expect(outcome.kind).toBe("already-serving");
    // The whole point: the second daemon does nothing, so the terminals the
    // incumbent holds are untouched and its clients never notice.
    expect(await answers(path)).toBe(true);
    await closed(incumbent);
  });

  test("a foreign-owned run directory refuses to serve", async () => {
    await using directory = await temporaryDirectory("socket");
    const run = join(directory.path, "run");
    await mkdir(run, { recursive: true, mode: 0o700 });

    const thrown = await bindDaemonSocket({
      path: join(run, "janelad.sock"),
      ownUid: ownUid() + 1,
      log: silent,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SocketDirectoryUnsafe);
  });
});
