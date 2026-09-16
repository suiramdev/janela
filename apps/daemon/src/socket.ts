import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, type Server } from "node:net";
import { dirname } from "node:path";

import { verifySocketDirectory, SOCKET_DIRECTORY_MODE } from "@janela/daemon";
import type { Logger } from "@janela/support";
import { Effect } from "effect";

export type BindOutcome = { readonly kind: "bound" } | { readonly kind: "already-serving" };

export interface BindDaemonSocketOptions {
  readonly server: Server;
  readonly path: string;
  readonly ownUid: number;
  readonly log: Logger;
}

export const SOCKET_FILE_MODE = 0o600;

export async function bindDaemonSocket(options: BindDaemonSocketOptions): Promise<BindOutcome> {
  const { server, path, ownUid, log } = options;

  if (server.listenerCount("connection") === 0) {
    throw new Error("bindDaemonSocket: attach the connection handler before binding");
  }

  const directory = dirname(path);

  await mkdir(directory, { recursive: true, mode: SOCKET_DIRECTORY_MODE });
  verifySocketDirectory(directory, ownUid);

  if (await isServing(path)) {
    log.info("another daemon is already serving");

    return { kind: "already-serving" };
  }

  await unlink(path).catch(() => undefined);

  const listening = Promise.withResolvers<void>();

  server.once("error", listening.reject);
  server.listen(path, () => {
    server.removeListener("error", listening.reject);
    listening.resolve();
  });

  await listening.promise;
  await chmod(path, SOCKET_FILE_MODE);

  log.info("listening");

  return { kind: "bound" };
}

function isServing(path: string): Promise<boolean> {
  const probe = connect(path);
  const { promise, resolve } = Promise.withResolvers<boolean>();

  probe.once("connect", () => resolve(true));
  probe.once("error", () => resolve(false));

  return Effect.runPromise(
    Effect.ensuring(
      Effect.promise(() => promise),
      Effect.sync(() => probe.destroy()),
    ),
  );
}
