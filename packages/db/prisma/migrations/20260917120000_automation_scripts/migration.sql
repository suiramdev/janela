-- CreateTable
CREATE TABLE "AutomationScript" (
    "projectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 30,

    PRIMARY KEY ("projectId", "event"),
    CONSTRAINT "AutomationScript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Convert: every argv row becomes one shell line, each argument single-quoted, a
-- disabled row commented out; the lines of one project's event join into one script
-- in their old position order. The teardown timeout is the first row's.
CREATE TEMP TABLE "_automation_lines" AS
SELECT
    c."projectId" AS "projectId",
    c."event" AS "event",
    c."position" AS "position",
    c."timeoutSeconds" AS "timeoutSeconds",
    CASE WHEN c."isEnabled" = 0 THEN '# ' ELSE '' END
        || rtrim(coalesce((
            SELECT group_concat('''' || replace(a.value, '''', '''\''''') || '''', ' ')
            FROM json_each(c."command") AS a
        ), ''))
        AS "line"
FROM "AutomationCommand" AS c
ORDER BY c."projectId", c."event", c."position";

INSERT INTO "AutomationScript" ("projectId", "event", "script", "timeoutSeconds")
SELECT
    "projectId",
    "event",
    group_concat("line", char(10)),
    (SELECT f."timeoutSeconds" FROM "_automation_lines" AS f
      WHERE f."projectId" = l."projectId" AND f."event" = l."event"
      ORDER BY f."position" LIMIT 1)
FROM "_automation_lines" AS l
GROUP BY "projectId", "event";

DROP TABLE "_automation_lines";

-- DropTable
DROP TABLE "AutomationCommand";
