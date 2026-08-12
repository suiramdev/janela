import Foundation
import JanelaCore

/// Correlates a request with its reply.
public struct RequestID: Hashable, Sendable, Codable {
    public let rawValue: UInt64

    public init(rawValue: UInt64) {
        self.rawValue = rawValue
    }
}

/// What a client can say.
///
/// Note what is *not* here: nothing lets a client read or write the database, and
/// nothing lets it start a process directly. Every capability is expressed as an
/// intent the daemon validates. If the CLI cannot do it through this enum, neither
/// can the app — see docs/decisions/0015-daemon-owned-sessions.md § Rules.
public enum ClientMessage: Sendable, Codable {

    /// Always first. Anything else before it is a protocol violation.
    case hello(Hello)

    /// Ask to be told about changes. Scoped, so a CLI listing sessions does not
    /// subscribe to terminal output it will never render.
    case subscribe(RequestID, SubscriptionScope)

    // MARK: Projects and sessions

    case addProject(RequestID, directory: URL, name: String?)
    case removeProject(RequestID, ProjectID)
    case updateProjectSettings(RequestID, ProjectID, ProjectSettings)

    case createSession(RequestID, SessionCreationIntent)
    case removeSession(RequestID, SessionID, deletesDirectory: Bool)
    case renameSession(RequestID, SessionID, name: String)

    // MARK: Terminals

    /// Attach to a terminal's output. `viewport` participates in the size
    /// negotiation described in docs/decisions/0016-daemon-protocol.md.
    case attach(RequestID, TerminalID, viewport: GridSize)
    case detach(RequestID, TerminalID)

    /// Start a configured-but-idle terminal. Attaching does not start anything;
    /// that would make opening a session spawn processes.
    case startTerminal(RequestID, TerminalID)
    case stopTerminal(RequestID, TerminalID)

    case resize(TerminalID, GridSize)

    /// Keyboard input. High frequency, and the only client message with no reply —
    /// a round trip per keystroke would be absurd, and the echo *is* the reply.
    case input(TerminalID, bytes: [UInt8])

    /// What is on screen, as text. The reason a CLI is useful to an agent.
    case snapshotText(RequestID, TerminalID, includeScrollback: Bool)
}

/// What the daemon can say.
public enum DaemonMessage: Sendable, Codable {

    case hello(Hello)
    case refused(HandshakeRefusal)

    /// Projects, sessions and terminal status. Sent unsolicited to subscribers, so
    /// a session created by the CLI appears in the app without the app asking.
    case state(StateUpdate)

    /// Repaint sequences for an attached terminal. High frequency; carried as a raw
    /// frame rather than inside JSON.
    case output(TerminalID, bytes: [UInt8])

    /// A terminal wants attention. A fact, not a decision — policy lives in the
    /// client. See docs/decisions/0011-notifications.md.
    case attention(AttentionSignal)

    case terminalExited(TerminalID, code: Int32)

    /// Reply to a request that succeeded and has no payload of its own.
    case acknowledged(RequestID)

    /// Reply to a request that failed. Carries text safe to show a person.
    case failed(RequestID, UserFacingFailure)

    case text(RequestID, String)
}

/// How much a client wants to hear about.
public enum SubscriptionScope: Hashable, Sendable, Codable {

    /// Everything except terminal output. What a sidebar needs.
    case state

    /// One terminal's output. Implied by `attach`, and listed separately because a
    /// client may subscribe to state without ever attaching to anything.
    case terminal(TerminalID)
}

/// A batch of changes. Whole objects rather than diffs: the data is kilobytes, and
/// a diff protocol for the sidebar would be a lot of machinery to save nothing.
public struct StateUpdate: Sendable, Codable {
    public var projects: [Project]
    public var sessions: [Session]
    public var terminalStates: [TerminalID: TerminalState]

    /// True when this is the complete picture rather than a change to part of it.
    /// Sent once after `subscribe`, and again after any reconnection.
    public var isFullSnapshot: Bool

    public init(
        projects: [Project] = [],
        sessions: [Session] = [],
        terminalStates: [TerminalID: TerminalState] = [:],
        isFullSnapshot: Bool = false
    ) {
        self.projects = projects
        self.sessions = sessions
        self.terminalStates = terminalStates
        self.isFullSnapshot = isFullSnapshot
    }
}

/// A terminal's size in cells.
///
/// Cells, not pixels. Pixel metrics are a client fact and do not survive multiple
/// clients on different displays — see docs/decisions/0004-terminal-engine.md.
public struct GridSize: Hashable, Sendable, Codable {
    public var columns: Int
    public var rows: Int

    public init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
    }
}

/// The wire form of a session creation request.
///
/// Mirrors `SessionCreationRequest` in the daemon rather than sharing it, because
/// this one is a *serialised intent* whose shape is frozen by the protocol version.
/// Letting an internal type define the wire format is how a refactor becomes a
/// breaking change for someone's script.
public enum SessionCreationIntent: Sendable, Codable {
    case standalone(directory: URL, name: String?)
    case inProject(ProjectID, name: String?)
    case newWorktree(project: ProjectID, branch: String, startPoint: String?, name: String?)
    case adoptWorktree(project: ProjectID, directory: URL, name: String?)
    case fromPullRequest(project: ProjectID, number: Int)
}

/// An error, reduced to what is safe and useful to show a person.
///
/// `UserFacingError` itself lives in `JanelaSupport`, which clients do not link.
/// This is its wire form, and the conversion is deliberately lossy: raw stderr and
/// underlying errors stay in the daemon's log.
public struct UserFacingFailure: Hashable, Sendable, Codable, Error {
    public var summary: String
    public var reason: String?
    public var recoverySuggestion: String?

    public init(summary: String, reason: String? = nil, recoverySuggestion: String? = nil) {
        self.summary = summary
        self.reason = reason
        self.recoverySuggestion = recoverySuggestion
    }
}

/// What a terminal reported, normalised, before any policy is applied.
public struct AttentionSignal: Hashable, Sendable, Codable {

    public enum Kind: Hashable, Sendable, Codable {
        case bell
        case notification(title: String?, body: String)
        case promptFinished(exitCode: Int32?, duration: Double)
    }

    public var kind: Kind
    public var terminalID: TerminalID
    public var sessionID: SessionID

    /// Set by the daemon so two clients can suppress a signal they have both
    /// already delivered.
    public var id: UUID

    public var occurredAt: Date

    public init(
        kind: Kind,
        terminalID: TerminalID,
        sessionID: SessionID,
        id: UUID = UUID(),
        occurredAt: Date = .now
    ) {
        self.kind = kind
        self.terminalID = terminalID
        self.sessionID = sessionID
        self.id = id
        self.occurredAt = occurredAt
    }
}
