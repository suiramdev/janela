-- RedefineTables: a terminal no longer names a launch profile, because there are
-- none. The column is a foreign key, which SQLite cannot DROP in place, so the
-- table is rebuilt the way Prisma's own RedefineTables does it. Declared
-- `rebuildsTables`, so the runner takes foreign keys off around the script and
-- runs `PRAGMA foreign_key_check` before committing: the copy is verified rather
-- than assumed. Nothing references "Terminal", so no cascade fires either way.
CREATE TABLE "new_Terminal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "workingDirectoryOverride" TEXT,
    "startsAutomatically" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL DEFAULT 'user',
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Terminal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Terminal" ("id", "sessionId", "title", "workingDirectoryOverride", "startsAutomatically", "role", "position", "createdAt")
SELECT "id", "sessionId", "title", "workingDirectoryOverride", "startsAutomatically", "role", "position", "createdAt" FROM "Terminal";
DROP TABLE "Terminal";
ALTER TABLE "new_Terminal" RENAME TO "Terminal";
CREATE INDEX "Terminal_sessionId_position_idx" ON "Terminal"("sessionId", "position");

-- DropTable: every terminal starts the user's login shell, so there is nothing
-- left for a stored command, icon or environment to name.
DROP TABLE "LaunchProfile";
