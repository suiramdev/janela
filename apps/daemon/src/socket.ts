import { chmod, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { dirname } from "node:path";

import { verifySocketDirectory, SOCKET_DIRECTORY_MODE } from "@janela/daemon";
import type { Logger } from "@janela/support";

/**
 * Binding the daemon's socket.
 *
 * ## Why the daemon binds it and launchd does not
 *
 * ADR 0017 originally offered socket activation, and #39 gave it up: the only
 * *static* form launchd offers — `SecureSocketWithKey` — publishes the socket path
 * solely into the GUI login session's launchd environment, which a CLI over ssh
 * cannot read, and ADR 0023 requires an address that survives launchd. So the
 * plist declares no `Sockets` block, there is no descriptor to inherit, and no
 * second FFI surface: `bun:ffi` stays gated to `@janela/pty`.
 *
 * The property socket activation was chosen for is kept on the client side
 * instead. The agent has no `RunAtLoad`, so nothing runs until a client fails to
 * connect and runs `launchctl kickstart gui/<uid>/sh.janela.janelad`. A user who
 * never opens Janela never has a process.
 *
 * **This is the one bind path.** The launchd start and `--foreground` are the same
 * code, so the mode, the directory check and the stale-file handling cannot drift
 * between a developer's run and a user's.
 */

/**
 * Mode for the socket file itself.
 *
 * `SockPathMode`'s replacement now that the plist declares no socket: launchd used
 * to be able to set this, and nothing does it for us any more. The 0700 directory
 * is the primary defence and the peer-uid check the second; this is the third, and
 * it costs one syscall.
 */
export const SOCKET_FILE_MODE = 0o600;

export type BindOutcome =
  /** Ours, listening, and ready for `socketListener`. */
  | { readonly kind: "bound"; readonly server: Server }
  /**
   * Something already answers on the path.
   *
   * Not an error: launchd may have started a second copy of us, or a developer's
   * `--foreground` run may be up. The caller exits 0 — a non-zero exit here would
   * make `KeepAlive.SuccessfulExit=false` respawn us into the same collision.
   */
  | { readonly kind: "already-serving" };

/**
 * Whether a live daemon is answering on `path`.
 *
 * A connect attempt rather than a lock file or a pid file: the socket *is* the
 * lock, and it is the only thing whose liveness matters to a client. An
 * `AF_UNIX` connect is answered by the kernel from the listener's backlog, so this
 * neither waits on the incumbent's accept loop nor needs a timeout.
 */
async function isServing(path: string): Promise<boolean> {
  const probe = connect(path);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  probe.once("connect", () => resolve(true));
  probe.once("error", () => resolve(false));
  try {
    return await promise;
  } finally {
    probe.destroy();
  }
}

/**
 * Creates the run directory, checks it, and binds `path`.
 *
 * @throws {SocketDirectoryUnsafe} when the directory is not a private directory
 *   this user owns. Left to propagate: the socket is a capability — anything that
 *   can connect can start processes as this user — so a daemon that cannot prove
 *   the directory is safe must not serve.
 */
export async function bindDaemonSocket(options: {
  readonly path: string;
  readonly ownUid: number;
  readonly log: Logger;
}): Promise<BindOutcome> {
  const { path, ownUid, log } = options;
  const directory = dirname(path);

  await mkdir(directory, { recursive: true, mode: SOCKET_DIRECTORY_MODE });
  // Creating it 0700 is not the same as it *being* 0700: it may have existed
  // already, with any mode and any owner.
  verifySocketDirectory(directory, ownUid);

  if (await isServing(path)) {
    log.info("another daemon is already serving");
    return { kind: "already-serving" };
  }

  // Nothing answered, so whatever is there is a leftover from a daemon that was
  // killed. `bind` fails with EADDRINUSE against a stale file, and unlinking one
  // nobody answers on is the only way a daemon recovers from `SIGKILL`.
  await unlink(path).catch(() => {
    // ENOENT is the normal case: the first ever start.
  });

  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(path, () => {
    server.removeListener("error", listening.reject);
    listening.resolve();
  });
  await listening.promise;

  // After `listen`, because the file does not exist before it.
  await chmod(path, SOCKET_FILE_MODE);
  log.info("listening");
  return { kind: "bound", server };
}
