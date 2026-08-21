import { Database } from "bun:sqlite";
import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import { PrismaClient } from "./generated/prisma/client";

const db = new Database("janela.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

const prisma = new PrismaClient({ adapter: new PrismaBunSqlite({ url: "file:janela.sqlite" }) });

const now = new Date();
await prisma.launchProfile.deleteMany();
const shell = await prisma.launchProfile.create({
  data: { id: "lp-shell", name: "Shell", symbolName: "terminal", command: "[]" },
});
const project = await prisma.project.create({
  data: { id: "p-1", name: "janela", directory: "/tmp/janela-" + Date.now(), addedAt: now, defaultProfileId: shell.id },
});
const session = await prisma.session.create({
  data: { id: "s-1", projectId: project.id, name: "fix/pty", directory: project.directory,
          backingKind: "worktree", layout: "{}", position: 0, createdAt: now, lastActiveAt: now },
});
await prisma.terminal.createMany({
  data: [
    { id: "t-1", sessionId: session.id, title: "agent", profileId: shell.id, position: 0, createdAt: now },
    { id: "t-2", sessionId: session.id, title: "server", position: 1, createdAt: now },
  ],
});

const withTerms = await prisma.session.findMany({ include: { terminals: true, project: true } });
console.log("DB read back:", withTerms.length, "session(s),",
            withTerms[0]?.terminals.length, "terminal(s), project:", withTerms[0]?.project?.name);

// ADR 0005 rule 3: deleting a project deletes its sessions and their terminals.
await prisma.project.delete({ where: { id: project.id } });
console.log("cascade — sessions left:", await prisma.session.count(),
            "terminals left:", await prisma.terminal.count(),
            "profile survived:", (await prisma.launchProfile.count()) === 1);
console.log("PRISMA+BUN:SQLITE OK");
process.exit(0);
