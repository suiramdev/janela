import type { AbsolutePath } from "@janela/core";

import type {
  LaunchProfileRepository,
  ProjectRepository,
  SessionRepository,
} from "./repositories.ts";

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
 *
 * See docs/decisions/0005-persistence.md and
 * docs/decisions/0019-prisma-sql-layer.md.
 */
export interface JanelaDatabase {
  /**
   * Runs pending migrations, then reports the schema version.
   *
   * Migration failure is the interesting error: it means the daemon cannot start,
   * and the only way a user learns about it is a client that cannot connect. It
   * must be logged clearly and exit non-zero so launchd's `KeepAlive` does not
   * spin. See docs/decisions/0017-daemon-lifecycle.md.
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
 * user processes in arbitrary directories. See
 * docs/decisions/0008-sandboxing-and-distribution.md.
 *
 * Note the socket lives somewhere else — `~/.janela/run/janelad.sock` — for an
 * unglamorous reason measured in docs/decisions/0016-daemon-protocol.md. Only the
 * socket moved.
 */
export function defaultDatabasePath(): AbsolutePath {
  throw new Error(`not implemented: defaultDatabasePath`);
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
}

export function openDatabase(options: OpenOptions): Promise<JanelaDatabase> {
  void options;
  throw new Error(`not implemented: openDatabase`);
}

/**
 * A real database on a temporary path, for tests.
 *
 * Not in-memory. Prisma's migration engine needs a file to migrate, and a test
 * that skips migrations is not testing the thing most likely to break a user's
 * session list. `@janela/test-support` provides the temporary directory.
 */
export function temporaryDatabase(): Promise<JanelaDatabase & { dispose(): Promise<void> }> {
  throw new Error(`not implemented: temporaryDatabase`);
}
