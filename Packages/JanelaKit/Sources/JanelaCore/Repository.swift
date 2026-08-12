import Foundation

/// A git repository Janela has been shown at least once.
///
/// Repositories exist so that "new workspace from branch X" is a one-step action.
/// They are a convenience index, not a container: deleting a repository record
/// never deletes workspaces, and workspaces can exist with no repository at all.
public struct Repository: Identifiable, Hashable, Sendable, Codable {
    public let id: RepositoryID

    /// Display name. Defaults to the directory name of `mainWorktreeDirectory`.
    public var name: String

    /// The repository's primary checkout — the one containing (or pointing at) `.git`.
    ///
    /// Note this is the *main worktree* in git's terminology, not the common dir.
    public var mainWorktreeDirectory: URL

    /// The `origin` remote URL, when there is one. Used only for display and for
    /// grouping worktrees that share an upstream.
    public var remoteURL: String?

    /// Cached at registration time so the "new worktree" sheet can preselect
    /// sensibly without shelling out. Refreshed opportunistically, never trusted
    /// for correctness.
    public var defaultBranch: String?

    public var addedAt: Date

    public init(
        id: RepositoryID = RepositoryID(),
        name: String,
        mainWorktreeDirectory: URL,
        remoteURL: String? = nil,
        defaultBranch: String? = nil,
        addedAt: Date = .now
    ) {
        self.id = id
        self.name = name
        self.mainWorktreeDirectory = mainWorktreeDirectory
        self.remoteURL = remoteURL
        self.defaultBranch = defaultBranch
        self.addedAt = addedAt
    }
}

/// Ties a workspace directory to the repository and branch it was cut from.
///
/// Kept as a small value type rather than a first-class entity on purpose: a
/// worktree has no independent life cycle in Janela. It is created with a
/// workspace and dies with it.
public struct WorktreeBinding: Hashable, Sendable, Codable {
    public let repositoryID: RepositoryID

    /// Branch checked out in the worktree. `nil` for a detached HEAD.
    public var branch: String?

    /// The commit the worktree was created at. Useful for detached-HEAD display and
    /// for telling the user how far behind they are.
    public var baseCommit: String?

    /// Absolute path of the worktree directory as git reports it. Should match the
    /// owning workspace's `directory`; a mismatch means the user moved it behind our
    /// back and we should re-resolve rather than guess.
    public var path: URL

    public init(repositoryID: RepositoryID, branch: String?, baseCommit: String? = nil, path: URL) {
        self.repositoryID = repositoryID
        self.branch = branch
        self.baseCommit = baseCommit
        self.path = path
    }
}
