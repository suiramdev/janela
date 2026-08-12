import OSLog

/// Janela's logging subsystem.
///
/// Rules of the road (see docs/conventions.md):
/// - Never `print()`. It is invisible in release builds and unsearchable in Console.
/// - Never log file contents, command output, environment values, notification
///   bodies, or the paths `.worktreeinclude` copied. Terminal traffic and
///   everything adjacent to it is the user's private data and must not leak into
///   the system log. Log the *shape*: a subcommand and its exit status, a terminal
///   id and its state transition, a file count and a total size.
/// - Prefer `.debug` for anything on a hot path; it compiles to near-nothing when
///   the subsystem is not being actively collected.
public enum Log {
    public static let subsystem = "sh.janela.Janela"

    /// App lifecycle, window and scene management.
    public static let app = Logger(subsystem: subsystem, category: "app")

    /// Project and session creation, opening, closing, deletion.
    public static let session = Logger(subsystem: subsystem, category: "session")

    /// Project automation commands: which event fired, which command index, and
    /// its exit status. Never the command's output — that belongs in its terminal,
    /// where the user can see it.
    public static let automation = Logger(subsystem: subsystem, category: "automation")

    /// Forge CLI invocations. Logs the subcommand and the failure class, never the
    /// JSON, which carries branch names and private repository names.
    public static let forge = Logger(subsystem: subsystem, category: "forge")

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
    public static let terminal = OSSignposter(
        subsystem: Log.subsystem, category: "terminal")
    public static let render = OSSignposter(
        subsystem: Log.subsystem, category: "render")
    public static let git = OSSignposter(
        subsystem: Log.subsystem, category: "git")
    /// Worktree add → `.worktreeinclude` copy → automation started. The one
    /// user-initiated flow with real work in it; budgets in docs/performance.md
    /// § Session creation.
    public static let sessionCreate = OSSignposter(
        subsystem: Log.subsystem, category: "sessionCreate")
    public static let forge = OSSignposter(
        subsystem: Log.subsystem, category: "forge")
}
