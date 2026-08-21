-- CreateTable
CREATE TABLE "LaunchProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "symbolName" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "isAgent" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "isForgeEnabled" BOOLEAN NOT NULL DEFAULT true,
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
    "layout" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "lastActiveAt" DATETIME NOT NULL,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "profileId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "Terminal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Terminal_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "LaunchProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_directory_key" ON "Project"("directory");

-- CreateIndex
CREATE INDEX "Session_projectId_position_idx" ON "Session"("projectId", "position");

-- CreateIndex
CREATE INDEX "Terminal_sessionId_position_idx" ON "Terminal"("sessionId", "position");
