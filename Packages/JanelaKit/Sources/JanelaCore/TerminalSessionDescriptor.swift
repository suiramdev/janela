import Foundation

/// The *persistable* description of a terminal session.
///
/// This is not the live session — that is `JanelaTerminal.TerminalSession`, an
/// actor holding a file descriptor and a child process. This type is the part we
/// can write to disk, diff, and restore at launch. Keeping the two separate is
/// what lets `JanelaCore` stay free of I/O.
public struct TerminalSessionDescriptor: Identifiable, Hashable, Sendable, Codable {
    public let id: SessionID

    /// Tab title. Starts from the launch profile's name, then follows the
    /// terminal's OSC 0/2 title sequences once the process starts talking.
    public var title: String

    /// What to run. `nil` means the user's login shell.
    public var profileID: LaunchProfileID?

    /// Working directory override. Defaults to the workspace directory when `nil`.
    /// Set when the user splits a session while `cd`'d somewhere else.
    public var workingDirectoryOverride: URL?

    /// Whether Janela should start this session automatically when the workspace
    /// is opened. Exactly one session is typically auto-started; the rest are lazy.
    public var startsAutomatically: Bool

    public var createdAt: Date

    public init(
        id: SessionID = SessionID(),
        title: String,
        profileID: LaunchProfileID? = nil,
        workingDirectoryOverride: URL? = nil,
        startsAutomatically: Bool = false,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.profileID = profileID
        self.workingDirectoryOverride = workingDirectoryOverride
        self.startsAutomatically = startsAutomatically
        self.createdAt = createdAt
    }
}

/// Coarse lifecycle state of a live session, as the UI needs to render it.
///
/// Note what is absent: there is no `.waitingForUser` or `.agentThinking`. Janela
/// does not attempt to parse agent semantics out of a byte stream. It reports what
/// the *terminal* told it (OSC 9 / OSC 777 notifications, OSC 133 prompt marks,
/// BEL) and nothing more. See docs/decisions/0006-agent-activity-signals.md.
public enum SessionState: Hashable, Sendable {

    /// Configured but no process spawned yet. Costs nothing; this is how we keep
    /// 40 open tabs cheap.
    case idle

    /// Child process is running.
    case running

    /// The terminal emitted an attention signal (BEL, OSC 9, or an OSC 133 prompt
    /// mark following a long-running command) and the session is not focused.
    case needsAttention

    /// Process exited. Carries the status so the UI can distinguish 0 from 130.
    case exited(code: Int32)

    /// Spawn failed. The associated message is safe to show a user.
    case failed(message: String)

    public var isLive: Bool {
        switch self {
        case .running, .needsAttention: true
        case .idle, .exited, .failed: false
        }
    }
}
