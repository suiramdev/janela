-- AlterTable: reading pull request state is no longer a per-project switch.
ALTER TABLE "Project" DROP COLUMN "isForgeEnabled";
