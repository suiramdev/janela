import OSLog

/// Janela's logging subsystem.
///
/// Rules of the road (see docs/conventions.md):
/// - Never `print()`. It is invisible in release builds and unsearchable in Console.
/// - Never log file contents, command output, or environment values. Terminal
///   traffic is the user's private data and must not leak into the system log.
/// - Prefer `.debug` for anything on a hot path; it compiles to near-nothing when
///   the subsystem is not being actively collected.
public enum Log {
    public static let subsystem = "sh.janela.Janela"

    /// App lifecycle, window and scene management.
    public static let app = Logger(subsystem: subsystem, category: "app")

    /// Workspace creation, opening, closing, deletion.
    public static let workspace = Logger(subsystem: subsystem, category: "workspace")

    /// PTY and child-process plumbing. Hot path — use `.debug`.
    public static let pty = Logger(subsystem: subsystem, category: "pty")

    /// Terminal emulation and rendering.
    public static let terminal = Logger(subsystem: subsystem, category: "terminal")

    /// Git invocations. Logs the subcommand and exit status, never full output.
    public static let git = Logger(subsystem: subsystem, category: "git")

    /// Database open, migration, and query failures.
    public static let persistence = Logger(subsystem: subsystem, category: "persistence")
}

/// Signpost handles for Instruments.
///
/// Every one of these corresponds to a budget in docs/performance.md. If you add a
/// signpost, add its budget too, otherwise it is decoration rather than a test.
public enum Signpost {
    public static let launch = OSSignposter(
        subsystem: Log.subsystem, category: "launch")
    public static let session = OSSignposter(
        subsystem: Log.subsystem, category: "session")
    public static let render = OSSignposter(
        subsystem: Log.subsystem, category: "render")
    public static let git = OSSignposter(
        subsystem: Log.subsystem, category: "git")
}
