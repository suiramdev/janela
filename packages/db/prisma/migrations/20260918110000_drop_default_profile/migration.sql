-- RedefineTables: a project no longer names a default launch profile; every new
-- terminal starts the login shell. The column is a foreign key, which SQLite
-- cannot DROP in place, so the table is rebuilt. Runs with foreign keys off:
-- with them on, DROP TABLE "Project" would cascade-delete every session.
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "remoteURL" TEXT,
    "defaultBranch" TEXT,
    "forge" TEXT,
    "worktreeRoot" TEXT NOT NULL DEFAULT 'siblingDirectory',
    "worktreeRootPath" TEXT,
    "accent" TEXT NOT NULL DEFAULT 'none',
    "isExpanded" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("id", "name", "directory", "remoteURL", "defaultBranch", "forge", "worktreeRoot", "worktreeRootPath", "accent", "isExpanded", "addedAt")
SELECT "id", "name", "directory", "remoteURL", "defaultBranch", "forge", "worktreeRoot", "worktreeRootPath", "accent", "isExpanded", "addedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_directory_key" ON "Project"("directory");
