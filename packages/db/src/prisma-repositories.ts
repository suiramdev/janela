import type { Project, ProjectID, Session, SessionID } from "@janela/core";
import { now, toDate } from "@janela/core";
import type { Logger } from "@janela/support";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import {
  decodeProject,
  decodeSession,
  encodeAutomation,
  encodeProject,
  encodeSession,
  encodeTerminal,
  requireWritableSession,
} from "./codec.ts";
import type { ProjectRepository, SessionRepository } from "./repositories.ts";

const BY_POSITION = { orderBy: { position: "asc" } } as const;

export function projectRepository(client: PrismaClient, log: Logger): ProjectRepository {
  return {
    async all(): Promise<readonly Project[]> {
      const rows = await client.project.findMany({
        include: { automation: true },
        orderBy: { name: "asc" },
      });

      return rows.map((row) => decodeProject(row, log));
    },

    async find(id: ProjectID): Promise<Project | undefined> {
      const row = await client.project.findUnique({
        where: { id },
        include: { automation: true },
      });

      return row === null ? undefined : decodeProject(row, log);
    },

    async save(project: Project): Promise<void> {
      const columns = encodeProject(project);
      const scripts = encodeAutomation(project.settings.automation, project.id);

      await client.$transaction(async (tx) => {
        await tx.project.upsert({
          where: { id: project.id },
          create: { id: project.id, ...columns },
          update: columns,
        });

        await tx.automationScript.deleteMany({ where: { projectId: project.id } });

        if (scripts.length > 0) await tx.automationScript.createMany({ data: [...scripts] });
      });
    },

    async remove(id: ProjectID): Promise<void> {
      await client.project.deleteMany({ where: { id } });
    },
  };
}

export function sessionRepository(client: PrismaClient, log: Logger): SessionRepository {
  return {
    async all(): Promise<readonly Session[]> {
      const rows = await client.session.findMany({
        include: { terminals: BY_POSITION },
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

        const obsolete: Prisma.TerminalWhereInput = { sessionId: session.id };

        if (keep.length > 0) obsolete.id = { notIn: keep };

        await tx.terminal.deleteMany({ where: obsolete });

        for (const [index, terminal] of session.terminals.entries()) {
          const row = encodeTerminal(terminal, session.id, index);

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
