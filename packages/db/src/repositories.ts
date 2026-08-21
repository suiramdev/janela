import type {
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  Session,
  SessionID,
} from "@janela/core";

/**
 * The repositories.
 *
 * Each one takes and returns `@janela/core` values, never Prisma models. That
 * boundary is the whole point of this package: Prisma is an implementation detail,
 * and a generated model type appearing in a `@janela/session` signature would make
 * the schema part of the brain's API. The layering gate enforces the import half of
 * that; keeping the *types* out is a review rule.
 *
 * The mapping is not free and should not pretend to be. Three places lose
 * information on the way in and must restore it on the way out:
 *
 *   - `Session.backing` is a discriminator plus nullable columns, so a
 *     half-populated row is representable and must be rejected on read rather than
 *     produce a nonsense `Backing`. `backingViolations` in `@janela/core` is what
 *     it is checked against.
 *   - `SessionLayout` is JSON, recursive, and depth-bounded. It is validated on
 *     both encode and decode, and a corrupt layout is *repaired* by dropping panes
 *     rather than failing the load — a session the user cannot open is worse than a
 *     session that lost a split.
 *   - `command` and `environment` are JSON arrays and objects. An argv array that
 *     round-trips into a string is the quoting bug class coming back in through the
 *     database.
 */

export interface ProjectRepository {
  all(): Promise<readonly Project[]>;
  find(id: ProjectID): Promise<Project | undefined>;
  /** Insert or update, including its automation commands. */
  save(project: Project): Promise<void>;
  /**
   * Deletes a project **and everything in it** — its sessions cascade, and their
   * terminals cascade from those. The caller must already have asked the removal
   * question for each session that owns a directory; this method does not ask.
   */
  remove(id: ProjectID): Promise<void>;
}

export interface SessionRepository {
  all(): Promise<readonly Session[]>;
  find(id: SessionID): Promise<Session | undefined>;
  inProject(id: ProjectID): Promise<readonly Session[]>;
  /** Sessions belonging to no project. A first-class case, not a leftover bucket. */
  standalone(): Promise<readonly Session[]>;
  /** Insert or update, including its terminals and layout. */
  save(session: Session): Promise<void>;
  remove(id: SessionID): Promise<void>;
  /** Cheap enough to call on every switch; it is one row. */
  touch(id: SessionID): Promise<void>;
}

export interface LaunchProfileRepository {
  all(): Promise<readonly LaunchProfile[]>;
  find(id: LaunchProfileID): Promise<LaunchProfile | undefined>;
  save(profile: LaunchProfile): Promise<void>;
  /**
   * Removing a profile never deletes a terminal that referenced it — the column is
   * `ON DELETE SET NULL`, and a terminal with no profile falls back to the login
   * shell. There is a test for exactly that.
   */
  remove(id: LaunchProfileID): Promise<void>;
  /** Inserts the built-ins on first open, without overwriting a user's edits. */
  seedBuiltIns(): Promise<void>;
}
