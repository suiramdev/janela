import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AbsolutePath } from "@janela/core";
import { absolutePath } from "@janela/core";
import type { Logger } from "@janela/support";

import { PrismaClient } from "../generated/prisma/client.ts";
import { janelaSqliteAdapter } from "./adapter.ts";
import { MIGRATIONS, applyMigrations } from "./migrations.ts";
import {
  launchProfileRepository,
  projectRepository,
  sessionRepository,
} from "./prisma-repositories.ts";
import type {
  LaunchProfileRepository,
  ProjectRepository,
  SessionRepository,
} from "./repositories.ts";

/**
 * The default when a caller injects nothing. Discarding is the right default for
 * the same reason `nullLogSink` is: a library must not decide the format for a
 * process that has not asked for one.
 */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  notice: () => {},
  warning: () => {},
  error: () => {},
};

/**
 * Janela's local store.
 *
 * **`janelad` opens it, and nothing else ever does.** Clients read state over the
 * protocol and never touch the file. SQLite's WAL mode would tolerate
 * multi-process access, so this is a choice rather than a limitation, and it is
 * worth the restraint: two writers means two sources of truth, reconciliation
 * logic, and a class of bug where the app's view of a session disagrees with the
 * process actually running it. One writer, one truth.
 *
 * The corollary is a rule the layering gate enforces rather than a reviewer:
 * **a client package that imports `@janela/db` is a layering bug.** `@janela/ui`
 * and `apps/desktop` do not link it at all.
 */
export interface JanelaDatabase {
  /**
   * Runs pending migrations, then reports the schema version.
   *
   * Migration failure is the interesting error: it means the daemon cannot start,
   * and the only way a user learns about it is a client that cannot connect. It
   * must be logged clearly and exit non-zero so launchd's `KeepAlive` does not
   * spin.
   */
  migrate(): Promise<void>;

  /** Closes the connection. Idempotent. */
  close(): Promise<void>;

  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly launchProfiles: LaunchProfileRepository;
}

/**
 * `~/Library/Application Support/sh.janela.Janela/janela.sqlite`
 *
 * Not in a container: Janela is not sandboxed, because it must spawn arbitrary
 * user processes in arbitrary directories.
 *
 * Note the socket lives somewhere else — `~/.janela/run/janelad.sock` — because
 * `sockaddr_un.sun_path` is 104 bytes on macOS and this directory does not fit in
 * it. Only the socket moved.
 */
export function defaultDatabasePath(): AbsolutePath {
  return absolutePath(
    join(homedir(), "Library", "Application Support", "sh.janela.Janela", "janela.sqlite"),
  );
}

export interface OpenOptions {
  readonly path: AbsolutePath;
  /**
   * Applied on open, and each one is a decision:
   * - WAL, so a read never blocks a write.
   * - `synchronous = NORMAL`, because losing the last few milliseconds of a
   *   session list to a power cut is not worth an fsync per commit.
   * - `foreign_keys = ON`, because the cascade rules *are* the product rules.
   * - a 2 s busy timeout, so nothing blocks indefinitely on a lock that should
   *   not exist given there is one writer.
   */
  readonly pragmas?: Readonly<Record<string, string>>;

  /**
   * Where this store's decode failures and repairs are reported. Injected rather
   * than taken from a module constant so a test can assert on them, and so the
   * daemon's sink is the one that gets them.
   */
  readonly log?: Logger;
}

export async function openDatabase(options: OpenOptions): Promise<JanelaDatabase> {
  const log = options.log ?? silentLogger;

  // SQLite creates the file but not its parents, and on a first launch there are
  // none. Doing it here rather than in the adapter keeps the adapter about SQL.
  await mkdir(dirname(options.path), { recursive: true });

  const factory = janelaSqliteAdapter({
    path: options.path,
    ...(options.pragmas === undefined ? {} : { pragmas: options.pragmas }),
  });
  const client = new PrismaClient({ adapter: factory });

  return {
    async migrate(): Promise<void> {
      // A second, short-lived connection: Prisma does not hand out the one it
      // holds, and it connects lazily on first query — so at startup there is
      // nothing to borrow. One writer either way, since this runs before the
      // daemon serves anything.
      const connection = await factory.connect();
      try {
        await applyMigrations(connection, MIGRATIONS, log);
      } finally {
        await connection.dispose();
      }
    },

    close(): Promise<void> {
      return client.$disconnect();
    },

    projects: projectRepository(client, log),
    sessions: sessionRepository(client, log),
    launchProfiles: launchProfileRepository(client),
  };
}

/**
 * A store on a throwaway path, with the path exposed.
 *
 * `path` is the tests' side door: corrupting a row means writing SQL the
 * repositories would refuse, and an injectable "write a bad row" seam would be a
 * hole in the real API.
 */
export interface TemporaryDatabase extends JanelaDatabase {
  readonly path: AbsolutePath;
  dispose(): Promise<void>;
}

/**
 * A real database on a temporary path, already migrated, for tests.
 *
 * Not in-memory. The migrations are the thing most likely to break a user's
 * session list, and a test that skips them is not testing that.
 *
 * The temporary directory is built here rather than taken from
 * `@janela/test-support`: that package is `tool`-side, and the layering gate lets
 * only a `*.test.ts` file import it. `realpath` for the reason its own helper
 * gives — on macOS `tmpdir()` is `/var/folders/…` while everything else reports
 * `/private/var/folders/…`, and a path that does not compare equal makes every
 * assertion about it a lie.
 */
export async function temporaryDatabase(options?: {
  readonly log?: Logger;
}): Promise<TemporaryDatabase> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "janela-db-")));
  const path = absolutePath(join(directory, "janela.sqlite"));
  const database = await openDatabase({
    path,
    ...(options?.log === undefined ? {} : { log: options.log }),
  });
  await database.migrate();

  return {
    ...database,
    path,
    async dispose(): Promise<void> {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
