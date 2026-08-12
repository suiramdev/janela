import Foundation

/// The *persistable* description of a terminal.
///
/// This is not the live terminal — that is `JanelaTerminal.LiveTerminal`, which
/// holds a file descriptor, a child process and an emulator. This type is the part
/// we can write to disk, diff, and restore at launch. Keeping the two separate is
/// what lets `JanelaCore` stay free of I/O, and it is what makes "restore my
/// layout" mean "restore descriptors" rather than "restart everyone's shells".
public struct TerminalDescriptor: Identifiable, Hashable, Sendable, Codable {
    public let id: TerminalID

    /// Tab title. Starts from the launch profile's name, then follows the
    /// terminal's OSC 0/2 title sequences once the process starts talking.
    public var title: String

    /// What to run. `nil` means the user's login shell.
    public var profileID: LaunchProfileID?

    /// Working directory override. Defaults to the session directory when `nil`.
    /// Set when the user splits a terminal while `cd`'d somewhere else.
    public var workingDirectoryOverride: URL?

    /// Whether Janela should start this terminal automatically when the session is
    /// opened. Typically true for the first terminal only; the rest are lazy.
    public var startsAutomatically: Bool

    /// Why this terminal exists.
    public var role: TerminalRole

    public var createdAt: Date

    public init(
        id: TerminalID = TerminalID(),
        title: String,
        profileID: LaunchProfileID? = nil,
        workingDirectoryOverride: URL? = nil,
        startsAutomatically: Bool = false,
        role: TerminalRole = .user,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.profileID = profileID
        self.workingDirectoryOverride = workingDirectoryOverride
        self.startsAutomatically = startsAutomatically
        self.role = role
        self.createdAt = createdAt
    }
}

/// Why a terminal exists.
///
/// Automation terminals are ordinary terminals with a label. They are not a hidden
/// process with a bespoke output view: everything Janela runs on the user's behalf
/// runs somewhere they can watch it, scroll it, and `Ctrl-C` it. See
/// docs/decisions/0014-project-automation.md.
public enum TerminalRole: Hashable, Sendable, Codable {

    /// The user asked for it.
    case user

    /// A project automation command runs here.
    case automation(AutomationEvent)

    public var isAutomation: Bool {
        if case .automation = self { return true }
        return false
    }
}

/// Coarse lifecycle state of a live terminal, as the UI needs to render it.
///
/// Note what is absent: there is no `.waitingForUser` or `.agentThinking`. Janela
/// does not attempt to parse agent semantics out of a byte stream. It reports what
/// the *terminal* told it (OSC 9 / OSC 777 notifications, OSC 133 prompt marks,
/// BEL) and nothing more. See docs/decisions/0006-agent-activity-signals.md.
///
/// A *session's* status is derived from its terminals rather than stored — see
/// `Session`. Two sources of truth for the thing the sidebar is judged on would be
/// one too many.
///
/// `Codable` because this crosses the socket: the daemon computes it and pushes it,
/// and clients render what they were told rather than inferring it from what they
/// themselves did. See docs/decisions/0015-daemon-owned-sessions.md.
public enum TerminalState: Hashable, Sendable, Codable {

    /// Configured but no process spawned yet. Costs nothing; this is how we keep
    /// 40 open terminals cheap.
    case idle

    /// Child process is running.
    case running

    /// The terminal emitted an attention signal (BEL, OSC 9, or an OSC 133 prompt
    /// mark following a long-running command) and is not focused.
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
