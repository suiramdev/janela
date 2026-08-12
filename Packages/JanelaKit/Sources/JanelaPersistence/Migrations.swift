import Foundation
import GRDB
import JanelaSupport

extension JanelaDatabase {

    /// The schema, as an append-only list of migrations.
    ///
    /// ## Rules
    ///
    /// 1. **Never edit a shipped migration.** Add a new one. A user's database is
    ///    already at v3; rewriting v3 does nothing for them and breaks everyone else.
    /// 2. **Name migrations by what they do**, not by version number alone.
    /// 3. Every migration must be exercised by a test that opens a database at the
    ///    previous version and migrates forward. See docs/testing.md § Migrations.
    public static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        #if DEBUG
        // Catches "I changed a migration" during development, loudly.
        migrator.eraseDatabaseOnSchemaChange = true
        #endif

        migrator.registerMigration("v1-initial") { db in
            try db.create(table: "repository") { table in
                table.primaryKey("id", .text)
                table.column("name", .text).notNull()
                table.column("mainWorktreeDirectory", .text).notNull().unique()
                table.column("remoteURL", .text)
                table.column("defaultBranch", .text)
                table.column("addedAt", .datetime).notNull()
            }

            try db.create(table: "workspace") { table in
                table.primaryKey("id", .text)
                table.column("name", .text).notNull()
                table.column("directory", .text).notNull()
                // Origin is stored as a discriminator plus optional payload rather
                // than as an opaque JSON blob, so it stays queryable ("show me every
                // workspace for repository X") without a table scan.
                table.column("originKind", .text).notNull()
                table.column("repositoryID", .text)
                    .references("repository", onDelete: .setNull)
                table.column("worktreeBranch", .text)
                table.column("worktreeBaseCommit", .text)
                table.column("accent", .text).notNull().defaults(to: "none")
                table.column("createdAt", .datetime).notNull()
                table.column("lastActiveAt", .datetime).notNull()
                table.column("isPinned", .boolean).notNull().defaults(to: false)
            }
            try db.create(index: "workspace_on_lastActiveAt", on: "workspace", columns: ["lastActiveAt"])

            try db.create(table: "launchProfile") { table in
                table.primaryKey("id", .text)
                table.column("name", .text).notNull()
                table.column("symbolName", .text).notNull()
                table.column("command", .text).notNull()  // JSON array
                table.column("environment", .text).notNull()  // JSON object
                table.column("isAgent", .boolean).notNull().defaults(to: false)
                table.column("isBuiltIn", .boolean).notNull().defaults(to: false)
            }

            try db.create(table: "session") { table in
                table.primaryKey("id", .text)
                table.column("workspaceID", .text).notNull()
                    .references("workspace", onDelete: .cascade)
                table.column("title", .text).notNull()
                table.column("profileID", .text).references("launchProfile", onDelete: .setNull)
                table.column("workingDirectoryOverride", .text)
                table.column("startsAutomatically", .boolean).notNull().defaults(to: false)
                table.column("position", .integer).notNull()
                table.column("createdAt", .datetime).notNull()
            }
            try db.create(
                index: "session_on_workspaceID_position",
                on: "session",
                columns: ["workspaceID", "position"]
            )
        }

        return migrator
    }
}
