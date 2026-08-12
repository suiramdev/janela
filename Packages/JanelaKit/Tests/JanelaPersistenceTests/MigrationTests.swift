import Foundation
import GRDB
import Testing

@testable import JanelaPersistence

@Suite("Schema migrations")
struct MigrationTests {

    @Test("A fresh database migrates to the latest schema")
    func freshDatabaseMigrates() throws {
        let database = try JanelaDatabase.inMemory()

        let tables = try database.read { db in
            try String.fetchAll(
                db,
                sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
        }

        #expect(tables.contains("project"))
        #expect(tables.contains("session"))
        #expect(tables.contains("terminal"))
        #expect(tables.contains("launchProfile"))
        #expect(tables.contains("automationCommand"))
    }

    @Test("Deleting a project deletes its sessions, their terminals, and its automation")
    func cascadeRules() throws {
        // This encodes product rules, not just schema details: a project contains
        // its sessions, a session contains its terminals, and nothing survives its
        // container. Getting this backwards orphans rows or strands a terminal
        // pointing at a directory nobody owns.
        let database = try JanelaDatabase.inMemory()

        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO project (id, name, directory, addedAt)
                    VALUES ('p1', 'repo', '/tmp/repo', '2026-01-01 00:00:00')
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO session
                        (id, projectID, name, directory, backingKind, layout, accent,
                         position, createdAt, lastActiveAt, isPinned)
                    VALUES
                        ('s1', 'p1', 'fix/pty', '/tmp/wt', 'worktree', '{}', 'none',
                         0, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO terminal (id, sessionID, title, startsAutomatically, role, position, createdAt)
                    VALUES ('t1', 's1', 'shell', 1, 'user', 0, '2026-01-01 00:00:00')
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO automationCommand (id, projectID, event, command, isEnabled, timeoutSeconds, position)
                    VALUES ('a1', 'p1', 'worktreeCreated', '[\"make\",\"setup\"]', 1, 30, 0)
                    """
            )
        }

        try database.write { db in
            try db.execute(sql: "DELETE FROM project WHERE id = 'p1'")
        }

        let counts = try database.read { db in
            (
                sessions: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session"),
                terminals: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM terminal"),
                automation: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM automationCommand")
            )
        }

        #expect(counts.sessions == 0)
        #expect(counts.terminals == 0)
        #expect(counts.automation == 0)
    }

    @Test("A standalone session survives having no project at all")
    func standaloneSessionsHaveNoProject() throws {
        // A standalone session is a first-class case, not a degenerate one, so
        // `projectID` must be genuinely nullable rather than nullable-by-accident.
        let database = try JanelaDatabase.inMemory()

        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO session
                        (id, projectID, name, directory, backingKind, layout, accent,
                         position, createdAt, lastActiveAt, isPinned)
                    VALUES
                        ('s1', NULL, 'scratch', '/tmp/scratch', 'folder', '{}', 'none',
                         0, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0)
                    """
            )
        }

        let count = try database.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session WHERE projectID IS NULL")
        }

        #expect(count == 1)
    }
}
