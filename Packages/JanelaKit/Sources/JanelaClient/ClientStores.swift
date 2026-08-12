import Foundation
import JanelaCore
import JanelaProtocol

/// The projects a client knows about.
///
/// A mirror of daemon state, not an owner of it. `@MainActor @Observable` because
/// it exists to drive views — the same reasoning that made the *old* single-process
/// stores main-actor, applied to what is left in the client.
@MainActor
@Observable
public final class ProjectStore {

    public private(set) var projects: [Project] = []

    public init() {}

    public func project(for id: ProjectID) -> Project? {
        projects.first { $0.id == id }
    }

    /// Applies a state update from the daemon.
    ///
    /// The only way this collection ever changes. There is no local mutation path,
    /// deliberately: "collapse this project" is a request, and the collapse renders
    /// when the daemon confirms it.
    func apply(_ update: StateUpdate) {
        if update.isFullSnapshot {
            projects = update.projects
        } else {
            // TODO: merge by id, preserving order. A partial update names only what
            // changed.
        }
    }
}

/// The sessions a client knows about, and which one is selected.
///
/// Note the split of ownership: `sessions` is the daemon's, `selection` is not.
/// Selection is per-window client state and never travels — two clients attached to
/// the same daemon look at different sessions, which is the entire point of being
/// able to open Janela on a phone while a Mac window is open.
@MainActor
@Observable
public final class SessionStore {

    public private(set) var sessions: [Session] = []

    /// Purely local. Never sent to the daemon, never received from it.
    public var selection: SessionID?

    /// Per-terminal status, as last reported.
    public private(set) var terminalStates: [TerminalID: TerminalState] = [:]

    public init() {}

    public func sessions(in projectID: ProjectID) -> [Session] {
        sessions.filter { $0.projectID == projectID }
    }

    public var standaloneSessions: [Session] {
        sessions.filter(\.isStandalone)
    }

    /// Whether a session has any live terminal.
    ///
    /// Derived from what the daemon reported, never inferred from what this client
    /// did. A session whose terminals we have not heard about is not running as far
    /// as we are concerned, and rendering it as running would be a lie we invented.
    public func isRunning(_ sessionID: SessionID) -> Bool {
        guard let session = sessions.first(where: { $0.id == sessionID }) else { return false }
        return session.terminals.contains { terminalStates[$0.id]?.isLive == true }
    }

    func apply(_ update: StateUpdate) {
        if update.isFullSnapshot {
            sessions = update.sessions
            terminalStates = update.terminalStates
        } else {
            // TODO: merge by id. Keep `selection` even when the selected session is
            // absent from a partial update — it may simply not have changed.
        }
    }
}
