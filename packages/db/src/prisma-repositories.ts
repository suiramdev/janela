/**
 * The repositories, over Prisma.
 *
 * Separate from `repositories.ts` because these factories take a `PrismaClient`,
 * and that type must not appear in anything `@janela/session` can see. The
 * interfaces are the package's API; this file is how they are met.
 *
 * Three rules run through all of it:
 *
 * - **A write validates first, then does I/O.** A caller's bug is reported as
 *   `InvalidRecord` before a row lands, because a row that lands is a row some
 *   later read has to refuse.
 * - **Children are reconciled, not merged.** `save` deletes the child rows the
 *   value no longer names and upserts the ones it does, in one transaction, so
 *   the stored set is exactly the value's set.
 * - **Cascades are the database's.** `remove` deletes one row and lets the
 *   foreign keys do the rest; emulating them here would be a second, divergent
 *   copy of the product rules the schema already states.
 */

import type {
  LaunchProfile,
  LaunchProfileID,
  Project,
  ProjectID,
  Session,
  SessionID,
} from "@janela/core";
import { BUILT_IN_PROFILES, newLaunchProfileID, now, toDate } from "@janela/core";
import type { Logger } from "@janela/support";

import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  decodeLaunchProfile,
  decodeProject,
  decodeSession,
  encodeAutomation,
  encodeLaunchProfile,
  encodeProject,
  encodeSession,
  encodeTerminal,
  requireWritableSession,
} from "./codec.ts";
import type {
  LaunchProfileRepository,
  ProjectRepository,
  SessionRepository,
} from "./repositories.ts";

/** Automation and terminal rows are only ever read in position order. */
const BY_POSITION = { orderBy: { position: "asc" } } as const;

export function projectRepository(client: PrismaClient, log: Logger): ProjectRepository {
  return {
    async all(): Promise<readonly Project[]> {
      const rows = await client.project.findMany({
        include: { automation: BY_POSITION },
        orderBy: { name: "asc" },
      });
      return rows.map((row) => decodeProject(row, log));
    },

    async find(id: ProjectID): Promise<Project | undefined> {
      const row = await client.project.findUnique({
        where: { id },
        include: { automation: BY_POSITION },
      });
      return row === null ? undefined : decodeProject(row, log);
    },

    async save(project: Project): Promise<void> {
      const columns = encodeProject(project);
      const commands = project.settings.automation;
      const keep = commands.map((command) => command.id);

      // A directory clash surfaces as Prisma's P2002 and a missing profile as
      // P2003, and both propagate: they are caller bugs about identity, not
      // decisions this repository gets to make.
      await client.$transaction(async (tx) => {
        await tx.project.upsert({
          where: { id: project.id },
          create: { id: project.id, ...columns },
          update: columns,
        });

        await tx.automationCommand.deleteMany({
          where: {
            projectId: project.id,
            ...(keep.length === 0 ? {} : { id: { notIn: keep } }),
          },
        });

        for (const [position, command] of commands.entries()) {
          const row = encodeAutomation(command, project.id, position);
          // One SQLite connection holds one transaction, and the adapter's
          // transaction lock serialises anything that tries otherwise — so
          // `Promise.all` here would queue the same statements with more moving
          // parts, not fewer round trips.
          // oxlint-disable-next-line no-await-in-loop
          await tx.automationCommand.upsert({
            where: { id: command.id },
            create: { id: command.id, ...row },
            update: row,
          });
        }
      });
    },

    async remove(id: ProjectID): Promise<void> {
      // `deleteMany` rather than `delete`: an absent id is a no-op, not a
      // failure. Callers reach here from a confirmation dialog, and a second
      // click must not throw.
      await client.project.deleteMany({ where: { id } });
    },
  };
}

export function sessionRepository(client: PrismaClient, log: Logger): SessionRepository {
  return {
    async all(): Promise<readonly Session[]> {
      const rows = await client.session.findMany({
        include: { terminals: BY_POSITION },
        // Standalone sessions first, then each project's own order.
        orderBy: [{ projectId: { sort: "asc", nulls: "first" } }, { position: "asc" }],
      });
      return rows.map((row) => decodeSession(row, log));
    },

    async find(id: SessionID): Promise<Session | undefined> {
      const row = await client.session.findUnique({
        where: { id },
        include: { terminals: BY_POSITION },
      });
      return row === null ? undefined : decodeSession(row, log);
    },

    async inProject(id: ProjectID): Promise<readonly Session[]> {
      const rows = await client.session.findMany({
        where: { projectId: id },
        include: { terminals: BY_POSITION },
        orderBy: { position: "asc" },
      });
      return rows.map((row) => decodeSession(row, log));
    },

    async standalone(): Promise<readonly Session[]> {
      const rows = await client.session.findMany({
        where: { projectId: null },
        include: { terminals: BY_POSITION },
        orderBy: { position: "asc" },
      });
      return rows.map((row) => decodeSession(row, log));
    },

    async save(session: Session): Promise<void> {
      requireWritableSession(session);

      const columns = encodeSession(session);
      const keep = session.terminals.map((terminal) => terminal.id);

      await client.$transaction(async (tx) => {
        const existing = await tx.session.findUnique({
          where: { id: session.id },
          select: { position: true },
        });

        // Position is assigned once, on first insert, as max+1 within the
        // project — or among standalone sessions. `save` never moves a session,
        // because reordering is a user action with its own entry point and this
        // interface does not have one yet.
        let position = existing?.position;
        if (position === undefined) {
          const { _max } = await tx.session.aggregate({
            where: { projectId: session.projectID ?? null },
            _max: { position: true },
          });
          position = (_max.position ?? -1) + 1;
        }

        await tx.session.upsert({
          where: { id: session.id },
          create: { id: session.id, position, ...columns },
          update: columns,
        });

        await tx.terminal.deleteMany({
          where: {
            sessionId: session.id,
            ...(keep.length === 0 ? {} : { id: { notIn: keep } }),
          },
        });

        for (const [index, terminal] of session.terminals.entries()) {
          const row = encodeTerminal(terminal, session.id, index);
          // Serialised for the same reason the automation upserts are: one
          // connection, one transaction.
          // oxlint-disable-next-line no-await-in-loop
          await tx.terminal.upsert({
            where: { id: terminal.id },
            create: { id: terminal.id, ...row },
            update: row,
          });
        }
      });
    },

    async remove(id: SessionID): Promise<void> {
      await client.session.deleteMany({ where: { id } });
    },

    async touch(id: SessionID): Promise<void> {
      await client.session.updateMany({ where: { id }, data: { lastActiveAt: toDate(now()) } });
    },
  };
}

export function launchProfileRepository(client: PrismaClient): LaunchProfileRepository {
  return {
    async all(): Promise<readonly LaunchProfile[]> {
      // Name order, not menu order: which profiles a menu shows and in what
      // sequence is a presentation decision, and this is a store.
      const rows = await client.launchProfile.findMany({ orderBy: { name: "asc" } });
      return rows.map(decodeLaunchProfile);
    },

    async find(id: LaunchProfileID): Promise<LaunchProfile | undefined> {
      const row = await client.launchProfile.findUnique({ where: { id } });
      return row === null ? undefined : decodeLaunchProfile(row);
    },

    async save(profile: LaunchProfile): Promise<void> {
      const columns = encodeLaunchProfile(profile);
      await client.launchProfile.upsert({
        where: { id: profile.id },
        create: { id: profile.id, ...columns },
        update: columns,
      });
    },

    async remove(id: LaunchProfileID): Promise<void> {
      // A built-in is protected by the service that owns the rule, not here. The
      // column is `ON DELETE SET NULL`, so a terminal that referenced this
      // profile survives and falls back to the login shell.
      await client.launchProfile.deleteMany({ where: { id } });
    },

    async seedBuiltIns(): Promise<void> {
      // Identity is the *name*: ids are minted at seed time, because a hardcoded
      // id would collide with a user's own copy of a built-in. So an edited
      // built-in is recognised and left exactly as the user left it.
      await client.$transaction(async (tx) => {
        const present = await tx.launchProfile.findMany({
          where: { isBuiltIn: true },
          select: { name: true },
        });
        const names = new Set(present.map((row) => row.name));

        for (const profile of BUILT_IN_PROFILES) {
          if (names.has(profile.name)) continue;
          // Serialised: one connection, one transaction.
          // oxlint-disable-next-line no-await-in-loop
          await tx.launchProfile.create({
            data: { id: newLaunchProfileID(), ...encodeLaunchProfile(profile) },
          });
        }
      });
    },
  };
}
