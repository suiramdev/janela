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
    ///    `v1-initial` was rewritten exactly once, before any release, when the
    ///    domain model changed — see docs/decisions/0005-persistence.md § Revisit
    ///    when. That exception is spent.
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
            // Tables are created in dependency order: a referenced table must exist
            // before the table that points at it. `launchProfile` therefore comes
            // first, because both `project` and `terminal` reference it.
            try db.create(table: "launchProfile") { table in
                table.primaryKey("id", .text)
                table.column("name", .text).notNull()
                table.column("symbolName", .text).notNull()
                table.column("command", .text).notNull()  // JSON array
                table.column("environment", .text).notNull()  // JSON object
                table.column("isAgent", .boolean).notNull().defaults(to: false)
                table.column("isBuiltIn", .boolean).notNull().defaults(to: false)
            }

            try db.create(table: "project") { table in
                table.primaryKey("id", .text)
                table.column("name", .text).notNull()
                table.column("directory", .text).notNull().unique()
                // Git facts are a display cache, never a source of truth. Nullable
                // throughout, because a plain folder is a perfectly good project.
                table.column("remoteURL", .text)
                table.column("defaultBranch", .text)
                table.column("forge", .text)
                table.column("worktreeRoot", .text).notNull().defaults(to: "sibling")
                table.column("worktreeRootPath", .text)
                table.column("defaultProfileID", .text)
                    .references("launchProfile", onDelete: .setNull)
                table.column("isForgeEnabled", .boolean).notNull().defaults(to: true)
                table.column("accent", .text).notNull().defaults(to: "none")
                table.column("isExpanded", .boolean).notNull().defaults(to: true)
                table.column("addedAt", .datetime).notNull()
            }

            try db.create(table: "session") { table in
                table.primaryKey("id", .text)
                // Nullable: a standalone session belongs to no project, and that is
                // a first-class case. Cascade rather than SET NULL, because a
                // worktree-backed session orphaned from its project would have a
                // `backing` nothing could interpret.
                table.column("projectID", .text)
                    .references("project", onDelete: .cascade)
                table.column("name", .text).notNull()
                table.column("directory", .text).notNull()
                // Backing is stored as a discriminator plus optional payload rather
                // than as an opaque JSON blob, so it stays queryable ("show me every
                // worktree session on branch X") without a table scan.
                table.column("backingKind", .text).notNull()
                table.column("worktreeBranch", .text)
                table.column("worktreeBaseCommit", .text)
                table.column("worktreeOwnership", .text)
                table.column("worktreeIncludedPaths", .text)  // JSON array
                // The split/tab tree. JSON because it is recursive and only ever
                // read whole; depth-bounded on decode, see SessionLayout.
                table.column("layout", .text).notNull()
                table.column("accent", .text).notNull().defaults(to: "none")
                table.column("position", .integer).notNull()
                table.column("createdAt", .datetime).notNull()
                table.column("lastActiveAt", .datetime).notNull()
                table.column("isPinned", .boolean).notNull().defaults(to: false)
            }
            try db.create(
                index: "session_on_projectID_position",
                on: "session",
                columns: ["projectID", "position"]
            )
            try db.create(
                index: "session_on_lastActiveAt", on: "session", columns: ["lastActiveAt"])

            try db.create(table: "terminal") { table in
                table.primaryKey("id", .text)
                table.column("sessionID", .text).notNull()
                    .references("session", onDelete: .cascade)
                table.column("title", .text).notNull()
                table.column("profileID", .text).references("launchProfile", onDelete: .setNull)
                table.column("workingDirectoryOverride", .text)
                table.column("startsAutomatically", .boolean).notNull().defaults(to: false)
                // "user", or the automation event this terminal was spawned for.
                table.column("role", .text).notNull().defaults(to: "user")
                table.column("position", .integer).notNull()
                table.column("createdAt", .datetime).notNull()
            }
            try db.create(
                index: "terminal_on_sessionID_position",
                on: "terminal",
                columns: ["sessionID", "position"]
            )

            // Automation commands live here and never in the user's repository: a
            // committed file that runs commands makes cloning a repo a
            // code-execution vector. See docs/decisions/0014-project-automation.md.
            try db.create(table: "automationCommand") { table in
                table.primaryKey("id", .text)
                table.column("projectID", .text).notNull()
                    .references("project", onDelete: .cascade)
                table.column("event", .text).notNull()
                table.column("command", .text).notNull()  // JSON array, never a shell string
                table.column("isEnabled", .boolean).notNull().defaults(to: true)
                table.column("timeoutSeconds", .integer).notNull().defaults(to: 30)
                table.column("position", .integer).notNull()
            }
            try db.create(
                index: "automationCommand_on_projectID_event",
                on: "automationCommand",
                columns: ["projectID", "event", "position"]
            )
        }

        return migrator
    }
}
