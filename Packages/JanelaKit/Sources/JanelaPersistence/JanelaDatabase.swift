import Foundation
import GRDB
import JanelaCore
import JanelaSupport

/// Janela's local store.
///
/// ## What lives here
///
/// Projects, sessions, terminal descriptors, session layouts, automation commands,
/// launch profiles.
/// Roughly: kilobytes. This database will never be large, and that is a design
/// constraint rather than an observation — if something wants to store megabytes
/// (scrollback, logs, agent transcripts) it does not belong in Janela's database.
///
/// ## What does not live here
///
/// - Terminal scrollback. It stays in the emulator's ring buffer and dies with
///   the terminal. Persisting it means unbounded growth and a privacy problem.
/// - Secrets. Anything sensitive belongs in the Keychain or the user's own
///   tooling — forge credentials in particular belong to `gh`/`glab` and never to
///   us. See docs/decisions/0012-forge-integration.md.
/// - Notification bodies. They are the user's own program's output; they reach
///   Notification Centre and nowhere else.
/// - Anything derivable from git or a forge. We cache display values with a
///   timestamp, but git is always the source of truth and we re-read rather than
///   reconcile.
public final class JanelaDatabase: Sendable {

    /// `~/Library/Application Support/sh.janela.Janela/janela.sqlite`
    ///
    /// Not in a container: Janela is not sandboxed (it must spawn arbitrary user
    /// processes in arbitrary directories). See
    /// docs/decisions/0008-sandboxing-and-distribution.md.
    public static func defaultURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return base.appending(path: "sh.janela.Janela/janela.sqlite")
    }

    private let writer: any DatabaseWriter

    public init(writer: any DatabaseWriter) throws {
        self.writer = writer
        try Self.migrator.migrate(writer)
    }

    /// Opens (creating if needed) the on-disk database.
    public static func open(at url: URL) throws -> JanelaDatabase {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)

        var configuration = Configuration()
        // WAL plus a short busy timeout: the UI must never block on the database,
        // and a background refresh must never make it.
        configuration.busyMode = .timeout(2)
        configuration.prepareDatabase { db in
            try db.execute(sql: "PRAGMA journal_mode = WAL")
            try db.execute(sql: "PRAGMA synchronous = NORMAL")
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }

        let pool = try DatabasePool(path: url.path(percentEncoded: false), configuration: configuration)
        return try JanelaDatabase(writer: pool)
    }

    /// An in-memory database for tests. See docs/testing.md.
    public static func inMemory() throws -> JanelaDatabase {
        try JanelaDatabase(writer: try DatabaseQueue())
    }

    public func read<T: Sendable>(_ body: @Sendable (Database) throws -> T) throws -> T {
        try writer.read(body)
    }

    public func write<T: Sendable>(_ body: @Sendable (Database) throws -> T) throws -> T {
        try writer.write(body)
    }
}
