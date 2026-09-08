import type { Socket } from "node:net";

import { absolutePath } from "@janela/core";
import {
  createDaemonServer,
  defaultSocketPath,
  socketListener,
  type DaemonServer,
  type RawPeerCredential,
} from "@janela/daemon";
import { openDatabase, type JanelaDatabase } from "@janela/db";
import { gitRunner, worktreeService } from "@janela/git";
import { readPeerCredential } from "@janela/pty";
import {
  createProjectService,
  createSessionService,
  resolveShellEnvironment,
  type ProjectRemovalObserving,
  type ProjectService,
  type SessionService,
  type ShellEnvironment,
  type StateObserving,
} from "@janela/session";
import { log, type Logger } from "@janela/support";
import { createTerminalRegistry, type TerminalRegistry } from "@janela/terminal";

import { bindDaemonSocket } from "./socket.ts";

/**
 * The daemon object graph.
 *
 * Constructor injection from one place, exactly as in the app. There is no service
 * locator, no singleton graph, and nothing global — which is also what makes the
 * whole graph substitutable in `@janela/daemon`'s tests.
 *
 * ## What startup does, and what it deliberately does not
 *
 * It opens the database, migrates it, captures the login shell's environment once,
 * and loads projects and sessions **from the database only**. That last part is the
 * whole of "sessions restore as idle": nothing probes git, nothing refreshes forge
 * state, and above all nothing spawns a process. A configured terminal that has not
 * been started costs nothing (non-negotiable #5), and the first client to connect
 * is waiting on this.
 */

export interface DaemonEnvironmentOptions {
  readonly databasePath: string;
  /**
   * A developer's run, with no launchd job above it.
   *
   * The bind path is identical either way — that is deliberate, so a mode cannot
   * drift between a developer's machine and a user's.
   */
  readonly foreground: boolean;
  /** Tests bind a throwaway path. Production takes `defaultSocketPath()`. */
  readonly socketPath?: string;
  readonly log?: Logger;
  /**
   * The captured login-shell environment. Production passes nothing and pays for
   * one `zsh -lc` at startup; a test passes a fixed one, because reading the
   * developer's dotfiles is neither fast nor hermetic.
   */
  readonly shell?: ShellEnvironment;
}

export interface DaemonEnvironment {
  /**
   * Binds the socket and serves until `signal` aborts.
   *
   * Returns without serving when another daemon already answers on the path: the
   * caller exits 0, because a non-zero exit would make `KeepAlive.SuccessfulExit=false`
   * respawn us into the same collision.
   */
  serve(signal: AbortSignal): Promise<void>;
  readonly server: DaemonServer;
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly terminals: TerminalRegistry;
  readonly database: JanelaDatabase;
}

/**
 * The descriptor behind an accepted socket.
 *
 * `_handle.fd` is a Bun internal, narrowed through `unknown` rather than asserted.
 * If a Bun upgrade removes it every peer is refused as `credential-unavailable` —
 * fail-closed, never fail-open — and the fix is a native `accept` beside the other
 * `jpty_*` exports.
 */
function descriptorOf(socket: Socket): number | undefined {
  // `Reflect.get` rather than a property access: the name is an internal, and it
  // is not in Bun's type declarations.
  const handle: unknown = Reflect.get(socket, "_handle");
  if (typeof handle !== "object" || handle === null) return undefined;
  const fd: unknown = Reflect.get(handle, "fd");
  return typeof fd === "number" ? fd : undefined;
}

export async function daemonEnvironment(
  options: DaemonEnvironmentOptions,
): Promise<DaemonEnvironment> {
  const logger = options.log ?? log("session");

  const database = await openDatabase({ path: absolutePath(options.databasePath), log: log("db") });
  // Left to propagate. Migration failure means the daemon cannot start, and the
  // only way a user learns about it is a client that cannot connect — so `main`
  // logs it and exits non-zero, which is what stops `KeepAlive` spinning.
  await database.migrate();

  const shell = options.shell ?? (await resolveShellEnvironment({ log: logger }));
  const git = gitRunner({ environment: shell.resolved });
  const worktrees = worktreeService(git);
  const terminals = createTerminalRegistry();

  // The server observes the services and the services announce through the
  // server, which is a cycle. Broken with a deferred reference rather than a
  // setter on the server: before `server` exists nothing can have subscribed, so
  // an announcement in that window has nobody to reach and dropping it is
  // correct rather than lossy.
  const deferred: { server?: DaemonServer } = {};
  const observer: StateObserving = {
    sessionsChanged: (updated) => deferred.server?.sessionsChanged(updated) ?? Promise.resolve(),
    projectsChanged: (updated) => deferred.server?.projectsChanged(updated) ?? Promise.resolve(),
  };

  // The same shape of cycle on the other diagonal: removing a project stops its
  // sessions' terminals, and the session service does not exist yet.
  const deferredRemoval: { service?: ProjectRemovalObserving } = {};
  const projects = createProjectService({
    repository: database.projects,
    git,
    observer,
    sessions: {
      projectRemoving: (id) => deferredRemoval.service?.projectRemoving(id) ?? Promise.resolve(),
    },
    log: logger,
  });
  const sessions = createSessionService({
    repository: database.sessions,
    profiles: database.launchProfiles,
    projects,
    worktrees,
    terminals,
    shell,
    observer,
    log: logger,
  });
  deferredRemoval.service = sessions;

  await projects.load();
  await sessions.load();

  // No `dispatch`: turning a message into calls on these services is #35's, and
  // the server answers a request with a log line until it is injected here.
  const daemonServer = createDaemonServer({
    sessions,
    projects,
    terminals,
    log: log("protocol"),
  });
  deferred.server = daemonServer;

  return {
    server: daemonServer,
    sessions,
    projects,
    terminals,
    database,

    async serve(signal: AbortSignal): Promise<void> {
      const ownUid = process.getuid?.();
      if (ownUid === undefined) {
        // `process.getuid` is optional in the types, and the peer check is the
        // whole of the socket's authorization. A daemon that cannot name its own
        // uid must not serve.
        throw new Error("this platform reports no uid, so no peer can be authorized");
      }

      const path = options.socketPath ?? defaultSocketPath();
      const bound = await bindDaemonSocket({ path, ownUid, log: log("protocol") });
      if (bound.kind === "already-serving") return;

      const listener = socketListener({
        server: bound.server,
        credentials: (socket: Socket): RawPeerCredential => {
          const fd = descriptorOf(socket);
          if (fd === undefined) return { xucred: undefined, pid: undefined };
          return readPeerCredential(fd);
        },
        ownUid,
        log: log("protocol"),
      });

      try {
        await daemonServer.serve(listener, signal);
      } finally {
        await listener.close();
      }
    },
  };
}
