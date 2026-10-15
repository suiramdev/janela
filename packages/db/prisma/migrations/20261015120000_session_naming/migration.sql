-- AlterTable
ALTER TABLE "Session" ADD COLUMN "nameOrigin" TEXT NOT NULL DEFAULT 'user';

-- Backfill: a name equal to what Janela would have derived — the worktree's branch,
-- the directory's last component, or the project's own name — is one Janela picked,
-- so Session naming may replace it. Every other name may have been typed by hand
-- and stays the user's.
UPDATE "Session"
SET "nameOrigin" = 'derived'
WHERE "name" = "worktreeBranch"
   OR substr("directory", -length("name") - 1) = '/' || "name"
   OR "name" IN (SELECT p."name" FROM "Project" AS p WHERE p."id" = "Session"."projectId");

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);
