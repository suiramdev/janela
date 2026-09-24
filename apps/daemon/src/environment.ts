import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";

import { absolutePath } from "@janela/core";
import {
  createDaemonServer,
  defaultSocketPath,
  socketListener,
  type DaemonServer,
  type RawPeerCredential,
} from "@janela/daemon";
import { openDatabase, type JanelaDatabase } from "@janela/db";
import { forgeService } from "@janela/forge";
import { gitRunner, worktreeService } from "@janela/git";
import { createIntegrationService } from "@janela/integrations";
import { readPeerCredential } from "@janela/pty";
import {
  createDirectoryBrowser,
  createForgeOverview,
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
import { processRunner } from "@janela/support/process";
import { createTerminalRegistry, type TerminalRegistry } from "@janela/terminal";
import { Effect, Option, Schema } from "effect";

import { bindDaemonSocket } from "./socket.ts";

export interface DaemonEnvironmentOptions {
  readonly databasePath: string;
  readonly foreground: boolean;
  readonly socketPath?: string;
  readonly log?: Logger;
  readonly shell?: ShellEnvironment;
}

export interface DaemonEnvironment {
  serve(signal: AbortSignal): Promise<void>;
  readonly server: DaemonServer;
  readonly sessions: SessionService;
  readonly projects: ProjectService;
  readonly terminals: TerminalRegistry;
  readonly database: JanelaDatabase;
}

interface DeferredServer {
  server?: DaemonServer;
}

interface DeferredRemovalObserver {
  service?: ProjectRemovalObserving;
}

const BUN_SOCKET_HANDLE_PROPERTY = "_handle";

const SocketWithDescriptor = Schema.Struct({
  [BUN_SOCKET_HANDLE_PROPERTY]: Schema.Struct({ fd: Schema.Number }),
});

const decodeSocketDescriptor = Schema.decodeUnknownOption(SocketWithDescriptor);

const UNAVAILABLE_CREDENTIAL: RawPeerCredential = { xucred: undefined, pid: undefined };

export async function daemonEnvironment(
  options: DaemonEnvironmentOptions,
): Promise<DaemonEnvironment> {
  const logger = options.log ?? log("session");
  const database = await openDatabase({ path: absolutePath(options.databasePath), log: log("db") });

  await database.migrate();

  const shell = options.shell ?? (await resolveShellEnvironment({ log: logger }));
  const git = gitRunner({ environment: shell.resolved });
  const worktrees = worktreeService(git);
  const terminals = createTerminalRegistry();
  const forge = forgeService({ environment: shell.resolved, log: log("forge") });
  const deferred: DeferredServer = {};
  const observer: StateObserving = {
    sessionsChanged: (updated) => deferred.server?.sessionsChanged(updated) ?? Promise.resolve(),
    projectsChanged: (updated) => deferred.server?.projectsChanged(updated) ?? Promise.resolve(),
  };

  const deferredRemoval: DeferredRemovalObserver = {};
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
    projects,
    worktrees,
    terminals,
    shell,
    observer,
    log: logger,
    forge,
  });

  deferredRemoval.service = sessions;

  await projects.load();
  await sessions.load();

  const daemonServer = createDaemonServer({
    sessions,
    projects,
    directories: createDirectoryBrowser({ home: absolutePath(homedir()) }),
    terminals,
    integrations: createIntegrationService({
      home: { directory: homedir(), environment: shell.resolved },
      processes: processRunner(),
      log: logger,
    }),
    forge: createForgeOverview({ projects, sessions, worktrees, forge }),
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
        throw new Error("this platform reports no uid, so no peer can be authorized");
      }

      const path = options.socketPath ?? defaultSocketPath();
      const server = createServer({ pauseOnConnect: true });
      const listener = socketListener({
        server,
        credentials: (socket: Socket): RawPeerCredential => {
          const fd = descriptorOf(socket);

          if (fd === undefined) return UNAVAILABLE_CREDENTIAL;

          return readPeerCredential(fd);
        },
        ownUid,
        log: log("protocol"),
      });

      const bound = await bindDaemonSocket({ server, path, ownUid, log: log("protocol") });

      if (bound.kind === "already-serving") return;

      await Effect.runPromise(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => daemonServer.serve(listener, signal),
            catch: (cause: unknown) => cause,
          }),
          Effect.promise(() => listener.close()),
        ),
      );
    },
  };
}

function descriptorOf(socket: Socket): number | undefined {
  const decoded = decodeSocketDescriptor(socket);

  if (Option.isNone(decoded)) return undefined;

  return decoded.value[BUN_SOCKET_HANDLE_PROPERTY].fd;
}
