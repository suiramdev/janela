import Foundation
import JanelaCore
import JanelaSupport

/// One entry from `git worktree list --porcelain`.
public struct GitWorktree: Hashable, Sendable {
    public var path: URL
    public var head: String?
    public var branch: String?
    public var isBare: Bool
    public var isDetached: Bool
    /// Set when another process holds the worktree (`git worktree lock`). We must
    /// never remove a locked worktree, and the reason is worth showing the user.
    public var lockReason: String?
    /// git considers the directory gone. Offer to prune rather than acting alone.
    public var isPrunable: Bool

    public init(
        path: URL,
        head: String? = nil,
        branch: String? = nil,
        isBare: Bool = false,
        isDetached: Bool = false,
        lockReason: String? = nil,
        isPrunable: Bool = false
    ) {
        self.path = path
        self.head = head
        self.branch = branch
        self.isBare = isBare
        self.isDetached = isDetached
        self.lockReason = lockReason
        self.isPrunable = isPrunable
    }
}

/// Everything Janela does with worktrees. Note how small it is: create, list,
/// remove, and check whether removal is safe. Anything more elaborate belongs in
/// the user's own git, not in this app.
public protocol WorktreeServing: Sendable {

    /// `git worktree list --porcelain -z` for a repository.
    func worktrees(inRepositoryAt directory: URL) async throws -> [GitWorktree]

    /// Creates a worktree. `branch` is created if it does not exist, checked out
    /// if it does. When `branch` is nil the worktree is detached at `startPoint`.
    ///
    /// - Parameters:
    ///   - repository: The repository's main worktree directory.
    ///   - directory: Where to place it. Janela's default is a sibling
    ///     `.worktrees/<slug>` directory inside the repository's parent, which keeps
    ///     `~/` tidy and keeps relative paths short. Users can override per creation.
    ///   - branch: Branch to check out or create; `nil` for a detached worktree.
    ///   - startPoint: Commit-ish to branch from. Defaults to `HEAD` when `nil`.
    /// - Returns: The worktree as git reports it after creation.
    /// - Throws: `GitFailure` when git refuses, most commonly because the branch is
    ///   already checked out in another worktree.
    func createWorktree(
        inRepositoryAt repository: URL,
        at directory: URL,
        branch: String?,
        startPoint: String?
    ) async throws -> GitWorktree

    /// Whether removing this worktree would lose work. Checked *before* we offer
    /// a destructive button, never after.
    func removalSafety(for worktree: GitWorktree) async -> WorktreeRemovalSafety

    /// `git worktree remove`, plus deleting the directory when git leaves it behind.
    func removeWorktree(at directory: URL, inRepositoryAt repository: URL, force: Bool) async throws
}

/// The production `WorktreeServing`, implemented on top of `GitRunning`.
///
/// Every method here is a thin translation between Janela's vocabulary and git's
/// porcelain output. There is no caching and no reconciliation: git is the source
/// of truth, and we re-read rather than try to stay in sync with it.
public struct WorktreeService: WorktreeServing {

    private let git: any GitRunning

    public init(git: any GitRunning) {
        self.git = git
    }

    public func worktrees(inRepositoryAt directory: URL) async throws -> [GitWorktree] {
        // TODO: `git worktree list --porcelain -z` and parse the NUL-delimited
        // records. Use -z because worktree paths can contain newlines.
        []
    }

    public func createWorktree(
        inRepositoryAt repository: URL,
        at directory: URL,
        branch: String?,
        startPoint: String?
    ) async throws -> GitWorktree {
        // TODO: `git worktree add [-b <branch>] <path> [<start-point>]`, then
        // re-read the list so the returned value is git's view rather than ours.
        throw GitFailure(subcommand: "worktree add", exitCode: -1, standardError: "not implemented")
    }

    public func removalSafety(for worktree: GitWorktree) async -> WorktreeRemovalSafety {
        // TODO: `git status --porcelain`, `git log @{upstream}..HEAD`, plus the
        // lock state already carried on `worktree`.
        WorktreeRemovalSafety(isLocked: worktree.lockReason != nil)
    }

    public func removeWorktree(
        at directory: URL,
        inRepositoryAt repository: URL,
        force: Bool
    ) async throws {
        // TODO: `git worktree remove [--force] <path>`.
        throw GitFailure(
            subcommand: "worktree remove", exitCode: -1, standardError: "not implemented")
    }
}

/// The result of asking "is it safe to delete this worktree?".
///
/// Modelled as an explicit list of reasons rather than a bool so the confirmation
/// dialog can say exactly what will be lost. "Are you sure?" is not a real warning.
public struct WorktreeRemovalSafety: Sendable {
    public var hasUncommittedChanges: Bool
    public var hasUntrackedFiles: Bool
    public var hasUnpushedCommits: Bool
    public var isLocked: Bool
    public var hasRunningSessions: Bool

    public var isTriviallySafe: Bool {
        !hasUncommittedChanges && !hasUntrackedFiles && !hasUnpushedCommits
            && !isLocked && !hasRunningSessions
    }

    public init(
        hasUncommittedChanges: Bool = false,
        hasUntrackedFiles: Bool = false,
        hasUnpushedCommits: Bool = false,
        isLocked: Bool = false,
        hasRunningSessions: Bool = false
    ) {
        self.hasUncommittedChanges = hasUncommittedChanges
        self.hasUntrackedFiles = hasUntrackedFiles
        self.hasUnpushedCommits = hasUnpushedCommits
        self.isLocked = isLocked
        self.hasRunningSessions = hasRunningSessions
    }
}
