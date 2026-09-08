-- CreateTable
CREATE TABLE "LaunchProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "iconName" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "isAgent" BOOLEAN NOT NULL DEFAULT false,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "remoteURL" TEXT,
    "defaultBranch" TEXT,
    "forge" TEXT,
    "worktreeRoot" TEXT NOT NULL DEFAULT 'siblingDirectory',
    "worktreeRootPath" TEXT,
    "isForgeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "accent" TEXT NOT NULL DEFAULT 'none',
    "isExpanded" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" DATETIME NOT NULL,
    "defaultProfileId" TEXT,
    CONSTRAINT "Project_defaultProfileId_fkey" FOREIGN KEY ("defaultProfileId") REFERENCES "LaunchProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "backingKind" TEXT NOT NULL,
    "worktreeBranch" TEXT,
    "worktreeBaseCommit" TEXT,
    "worktreeOwnership" TEXT,
    "worktreeIncludedPaths" TEXT,
    "layout" TEXT NOT NULL,
    "accent" TEXT NOT NULL DEFAULT 'none',
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "lastActiveAt" DATETIME NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "workingDirectoryOverride" TEXT,
    "startsAutomatically" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT NOT NULL DEFAULT 'user',
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "profileId" TEXT,
    CONSTRAINT "Terminal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Terminal_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "LaunchProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutomationCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 30,
    "position" INTEGER NOT NULL,
    CONSTRAINT "AutomationCommand_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_directory_key" ON "Project"("directory");

-- CreateIndex
CREATE INDEX "Session_projectId_position_idx" ON "Session"("projectId", "position");

-- CreateIndex
CREATE INDEX "Session_lastActiveAt_idx" ON "Session"("lastActiveAt");

-- CreateIndex
CREATE INDEX "Terminal_sessionId_position_idx" ON "Terminal"("sessionId", "position");

-- CreateIndex
CREATE INDEX "AutomationCommand_projectId_event_position_idx" ON "AutomationCommand"("projectId", "event", "position");
