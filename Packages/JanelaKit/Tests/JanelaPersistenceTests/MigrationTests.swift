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

        #expect(tables.contains("workspace"))
        #expect(tables.contains("repository"))
        #expect(tables.contains("session"))
        #expect(tables.contains("launchProfile"))
    }

    @Test("Deleting a workspace deletes its sessions but never its repository")
    func cascadeRules() throws {
        // This encodes a product rule, not just a schema detail: repositories
        // outlive the workspaces cut from them, and sessions never outlive their
        // workspace. Getting this backwards orphans rows or deletes user data.
        let database = try JanelaDatabase.inMemory()

        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO repository (id, name, mainWorktreeDirectory, addedAt)
                    VALUES ('r1', 'repo', '/tmp/repo', '2026-01-01 00:00:00')
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO workspace
                        (id, name, directory, originKind, repositoryID, accent, createdAt, lastActiveAt, isPinned)
                    VALUES
                        ('w1', 'ws', '/tmp/ws', 'repositoryCheckout', 'r1', 'none',
                         '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO session (id, workspaceID, title, startsAutomatically, position, createdAt)
                    VALUES ('s1', 'w1', 'shell', 1, 0, '2026-01-01 00:00:00')
                    """
            )
        }

        try database.write { db in
            try db.execute(sql: "DELETE FROM workspace WHERE id = 'w1'")
        }

        let counts = try database.read { db in
            (
                sessions: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session"),
                repositories: try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM repository")
            )
        }

        #expect(counts.sessions == 0)
        #expect(counts.repositories == 1)
    }
}
