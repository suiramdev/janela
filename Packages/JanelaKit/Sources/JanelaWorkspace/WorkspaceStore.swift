import Foundation
import JanelaCore
import JanelaGit
import JanelaPersistence
import JanelaSupport
import JanelaTerminal

/// The application's brain: the observable list of workspaces and the operations
/// that change it.
///
/// Everything the UI can do to a workspace goes through here, and nothing here
/// knows what a `View` is. That split is what lets the entire workspace lifecycle
/// be tested with no window server — see docs/testing.md.
@MainActor
@Observable
public final class WorkspaceStore {

    public private(set) var workspaces: [Workspace] = []
    public private(set) var repositories: [Repository] = []

    /// The workspace the frontmost window is showing.
    public var selection: WorkspaceID?

    private let database: JanelaDatabase
    private let worktrees: any WorktreeServing
    private let sessions: SessionRegistry

    public init(
        database: JanelaDatabase,
        worktrees: any WorktreeServing,
        sessions: SessionRegistry
    ) {
        self.database = database
        self.worktrees = worktrees
        self.sessions = sessions
    }

    // MARK: - Reading

    /// Loads persisted state. Called once, early, and must stay fast: it is on the
    /// critical path to first paint. See docs/performance.md § Launch.
    public func load() async throws {}

    // MARK: - Creating

    /// The single entry point for workspace creation.
    ///
    /// Note that worktree creation is *one case of this function*, not a separate
    /// feature with its own screen. That is the product thesis expressed as an API:
    /// if this ever grows a second public creation method, something has gone wrong.
    public func createWorkspace(_ request: WorkspaceCreationRequest) async throws -> Workspace {
        throw UnexpectedFailure(
            summary: "Not implemented yet.",
            underlying: CocoaError(.featureUnsupported)
        )
    }

    // MARK: - Deleting

    /// Checks what would be lost, so the UI can describe it before asking.
    public func removalPlan(for id: WorkspaceID) async -> WorkspaceRemovalPlan {
        WorkspaceRemovalPlan()
    }

    /// Removes a workspace. Only deletes files when `plan.deletesDirectory` is true
    /// *and* the caller explicitly opted in.
    public func removeWorkspace(_ id: WorkspaceID, applying plan: WorkspaceRemovalPlan) async throws {}
}

/// How the user asked for a workspace to come into being.
///
/// One enum, four cases, and they all end in the same place: a directory with a
/// name and some terminals.
public enum WorkspaceCreationRequest: Sendable {

    /// "Open this folder." The most common case, and the one that must never
    /// require thinking about git.
    case folder(directory: URL, name: String?)

    /// "Open this repository's main checkout."
    case repository(directory: URL, name: String?)

    /// "Give me a new branch to work on." Creates a worktree behind the scenes.
    /// The user picks a branch name; Janela picks the directory unless told otherwise.
    case newBranch(
        repository: RepositoryID,
        branch: String,
        startPoint: String?,
        directory: URL?,
        name: String?
    )

    /// "I already have this worktree, manage it too."
    case existingWorktree(repository: RepositoryID, directory: URL, name: String?)
}

/// What removing a workspace will actually do.
public struct WorkspaceRemovalPlan: Sendable {
    /// Sessions that will be killed.
    public var liveSessionCount: Int = 0
    /// True when Janela created the directory and can therefore offer to delete it.
    public var canDeleteDirectory: Bool = false
    /// Set by the UI when the user ticks "also delete the worktree".
    public var deletesDirectory: Bool = false
    /// Reasons deleting would lose work.
    public var safety: WorktreeRemovalSafety = WorktreeRemovalSafety()

    public init() {}
}
