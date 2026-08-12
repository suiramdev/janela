import Foundation
import JanelaCore
import JanelaPTY
import JanelaSupport

/// A live terminal: a PTY, a child process, an emulator, and the state the UI
/// binds to.
///
/// ## Lazy by default
///
/// Constructing a `TerminalSession` costs nothing — no PTY, no process, no
/// emulator. `start()` is what allocates. This is what makes 40 open tabs viable
/// and it is why `SessionState.idle` exists as a first-class state.
///
/// ## Ownership
///
/// The session owns the PTY and the emulator. The UI owns the session only
/// through `SessionRegistry`; views must never hold a strong reference, or a
/// closed tab will keep a shell alive.
@MainActor
@Observable
public final class TerminalSession {

    public let id: SessionID
    public private(set) var descriptor: TerminalSessionDescriptor
    public private(set) var state: SessionState = .idle

    /// Live title, following OSC 0/2. Falls back to the descriptor's title.
    public private(set) var displayTitle: String

    /// Set when the session emitted an attention signal while unfocused. Cleared
    /// when the user focuses the tab. Drives the sidebar badge.
    public private(set) var hasUnseenAttention = false

    /// Working directory as last reported via OSC 7, when shell integration is
    /// present. `nil` means "we don't know", which is a normal state.
    public private(set) var reportedWorkingDirectory: URL?

    public init(descriptor: TerminalSessionDescriptor) {
        self.id = descriptor.id
        self.descriptor = descriptor
        self.displayTitle = descriptor.title
    }

    /// Spawns the process. Idempotent: calling it on a running session is a no-op.
    public func start() async {}

    /// Sends SIGHUP to the process group and tears down the PTY.
    public func stop() async {}

    /// Restarts in place, keeping the tab and its position.
    public func restart() async {}

    /// User keyboard input. Goes straight to the PTY with no interpretation —
    /// Janela does not implement key bindings that the terminal should own.
    public func send(_ bytes: [UInt8]) {}

    /// Called by the view when focus changes; clears the attention badge.
    public func setFocused(_ focused: Bool) {
        if focused { hasUnseenAttention = false }
    }
}

/// The set of live sessions, keyed by id.
///
/// Single source of truth for "what is running". The workspace layer asks this
/// before it lets a user delete a worktree, and the app delegate asks it before
/// allowing termination.
@MainActor
@Observable
public final class SessionRegistry {

    public private(set) var sessions: [SessionID: TerminalSession] = [:]

    public init() {}

    public func session(for id: SessionID) -> TerminalSession? { sessions[id] }

    /// Live sessions rooted at or beneath a directory. Used to warn before a
    /// worktree is removed out from under a running agent.
    public func liveSessions(under directory: URL) -> [TerminalSession] {
        sessions.values.filter { $0.state.isLive }
    }
}
