import Foundation
import JanelaCore
import JanelaGit
import JanelaPersistence
import JanelaSupport
import JanelaTerminal

/// The application's brain: sessions, and the operations that change them.
///
/// ## Where this runs
///
/// **In the daemon.** It owns the truth; clients hold mirrors of it and ask for
/// changes over the protocol. Nothing here knows a socket exists, and that is the
/// test of whether the layering is right — `JanelaSession` must stay usable with no
/// networking at all, which is exactly how its tests use it.
///
/// An actor rather than a `@MainActor @Observable` class, because there is no main
/// actor in `janelad` and nothing here exists to drive a view.
/// See docs/decisions/0015-daemon-owned-sessions.md.
public actor SessionService {

    /// Every session, both grouped and standalone.
    public private(set) var sessions: [Session] = []

    private let database: JanelaDatabase
    private let worktrees: any WorktreeServing
    private let terminals: TerminalRegistry
    private let observer: any StateObserving

    public init(
        database: JanelaDatabase,
        worktrees: any WorktreeServing,
        terminals: TerminalRegistry,
        observer: any StateObserving
    ) {
        self.database = database
        self.worktrees = worktrees
        self.terminals = terminals
        self.observer = observer
    }

    // MARK: - Reading

    /// Loads persisted state. Called once, early in daemon startup.
    public func load() async throws {}

    public func sessions(in projectID: ProjectID) -> [Session] {
        sessions.filter { $0.projectID == projectID }
    }

    /// Sessions belonging to no project. A first-class case, not a leftover bucket.
    public var standaloneSessions: [Session] {
        sessions.filter(\.isStandalone)
    }

    // MARK: - Creating

    /// The single entry point for session creation.
    ///
    /// Worktree creation is *one case of this function*, not a separate feature with
    /// its own screen. If this ever grows a second public creation method, something
    /// has gone wrong.
    ///
    /// Nothing here blocks on a client. The session is persisted and announced
    /// before `.worktreeinclude` copying and automation finish, and the client that
    /// asked may disconnect mid-flight without changing the outcome — see
    /// docs/architecture.md § Creating a session.
    public func createSession(_ request: SessionCreationRequest) async throws -> Session {
        // TODO: worktree add → .worktreeinclude copy → .worktreeCreated automation
        // → .sessionStart automation → the user's first terminal, in that order.
        // The order is documented in docs/decisions/0013-worktreeinclude.md and
        // scripts depend on it. Publish progress through `observer` at each step.
        throw UnexpectedFailure(
            summary: "Not implemented yet.",
            underlying: CocoaError(.featureUnsupported)
        )
    }

    // MARK: - Deleting

    /// Checks what would be lost, so a client can describe it before asking.
    public func removalPlan(for id: SessionID) async -> SessionRemovalPlan {
        SessionRemovalPlan()
    }

    /// Removes a session. Only deletes files when `plan.deletesDirectory` is true
    /// *and* the caller explicitly opted in.
    ///
    /// Runs `.sessionTeardown` automation first, bounded by its timeout, and **runs
    /// it to completion even if the requesting client disconnects**. A teardown
    /// abandoned halfway because a window closed would leave exactly the containers
    /// and databases it exists to clean up.
    public func removeSession(_ id: SessionID, applying plan: SessionRemovalPlan) async throws {}
}

/// How the brain announces change without knowing who is listening.
///
/// `DaemonServer` implements this and fans out to subscribers. A test implements it
/// with an array. Neither is visible from here, which is the point: this module
/// does not import `JanelaProtocol` and cannot accidentally grow a dependency on
/// the wire format.
public protocol StateObserving: Sendable {
    func sessionsChanged(_ sessions: [Session]) async
    func projectsChanged(_ projects: [Project]) async
}

/// How the user asked for a session to come into being.
///
/// One enum, five cases, all ending in the same place: a directory with a name and
/// some terminals.
public enum SessionCreationRequest: Sendable {

    /// "Just give me a terminal in this folder." No project, no git, no ceremony.
    case standalone(directory: URL, name: String?)

    /// A simple session running in the project's own directory.
    case inProject(ProjectID, name: String?)

    /// "Give me a new branch to work on." Creates a worktree behind the scenes,
    /// placed according to the project's `worktreeRoot` unless told otherwise.
    case newWorktree(
        project: ProjectID,
        branch: String,
        startPoint: String?,
        directory: URL?,
        name: String?
    )

    /// "I already have this worktree, manage it too." Adopted, never deletable.
    case adoptWorktree(project: ProjectID, directory: URL, name: String?)

    /// "Work on this pull request." Resolves the head branch through the forge CLI,
    /// then creates a worktree — never `gh pr checkout`, which would mutate the
    /// user's own checkout. See docs/decisions/0012-forge-integration.md.
    case fromPullRequest(project: ProjectID, number: Int)
}

/// What removing a session will actually do.
///
/// Specifics rather than a bool, so the confirmation can name what is about to be
/// lost. "Are you sure?" is not a warning.
public struct SessionRemovalPlan: Sendable {

    /// Terminals that will be killed, across every tab and split.
    public var liveTerminalCount: Int = 0

    /// True when Janela created the directory and can therefore offer to delete it.
    /// False for a project directory and for an adopted worktree, always.
    public var canDeleteDirectory: Bool = false

    /// Set by the client when the user ticks "also delete the worktree".
    public var deletesDirectory: Bool = false

    /// Files `.worktreeinclude` copied in, which would go with the directory. Worth
    /// naming: an `.env` that exists nowhere else is not recoverable from git.
    public var includedPaths: [String] = []

    /// A `.sessionTeardown` command will run first, and deletion waits for it.
    public var runsTeardownAutomation: Bool = false

    /// Reasons deleting would lose work.
    public var safety: WorktreeRemovalSafety = WorktreeRemovalSafety()

    public init() {}
}
