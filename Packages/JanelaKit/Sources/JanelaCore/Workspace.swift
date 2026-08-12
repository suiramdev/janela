import Foundation

/// The one concept a user has to understand to use Janela.
///
/// A workspace is *a named directory with terminals in it*. That is the whole
/// idea. Everything else — repositories, worktrees, agents — hangs off that
/// sentence rather than competing with it.
///
/// Deliberately **not** modelled here:
/// - Projects/folders/groups. Workspaces are a flat, searchable list.
/// - Per-workspace settings trees. Settings are global; workspaces carry state.
/// - Tasks/runs/jobs. A running thing is a session, and nothing else.
public struct Workspace: Identifiable, Hashable, Sendable, Codable {
    public let id: WorkspaceID

    /// User-facing name. Defaults to the directory name, always editable, never
    /// required to be unique — humans are bad at unique names and we do not need it.
    public var name: String

    /// The directory terminals open in. This is the workspace's centre of gravity.
    ///
    /// It is stored as an absolute path and may point at a plain folder, a git
    /// repository's main checkout, or a git worktree. Janela does not care which;
    /// `origin` records how it came to exist.
    public var directory: URL

    /// How this workspace's directory came about.
    public var origin: Origin

    /// Ordered terminal sessions. Order is the tab order the user sees.
    public var sessions: [TerminalSessionDescriptor]

    /// Freeform colour tag used in the sidebar. Purely cosmetic, and that is fine —
    /// people navigate a list of 30 workspaces by colour far faster than by name.
    public var accent: Accent

    public var createdAt: Date
    public var lastActiveAt: Date

    /// Set when the user pins a workspace to the top of the sidebar.
    public var isPinned: Bool

    public init(
        id: WorkspaceID = WorkspaceID(),
        name: String,
        directory: URL,
        origin: Origin,
        sessions: [TerminalSessionDescriptor] = [],
        accent: Accent = .none,
        createdAt: Date = .now,
        lastActiveAt: Date = .now,
        isPinned: Bool = false
    ) {
        self.id = id
        self.name = name
        self.directory = directory
        self.origin = origin
        self.sessions = sessions
        self.accent = accent
        self.createdAt = createdAt
        self.lastActiveAt = lastActiveAt
        self.isPinned = isPinned
    }
}

extension Workspace {

    /// Where a workspace's directory came from.
    ///
    /// This is the *only* place worktree-ness enters the model. A worktree-backed
    /// workspace is a normal workspace with extra provenance — not a separate type,
    /// not a separate list, not a separate screen. That asymmetry is the whole
    /// product thesis; see docs/product.md.
    public enum Origin: Hashable, Sendable, Codable {

        /// A directory the user picked. No git involvement assumed (though the
        /// directory may well be a git repo — we detect that opportunistically).
        case folder

        /// The primary checkout of a repository Janela knows about.
        case repositoryCheckout(RepositoryID)

        /// A git worktree Janela created, and is therefore responsible for cleaning up.
        case managedWorktree(WorktreeBinding)

        /// A git worktree that already existed when we found it. We will never
        /// delete one of these without an explicit, unambiguous user action.
        case adoptedWorktree(WorktreeBinding)
    }

    /// The worktree binding, if this workspace has one.
    public var worktree: WorktreeBinding? {
        switch origin {
        case .managedWorktree(let binding), .adoptedWorktree(let binding):
            binding
        case .folder, .repositoryCheckout:
            nil
        }
    }

    /// The repository this workspace belongs to, if any.
    public var repositoryID: RepositoryID? {
        switch origin {
        case .repositoryCheckout(let id): id
        case .managedWorktree(let binding), .adoptedWorktree(let binding): binding.repositoryID
        case .folder: nil
        }
    }

    /// True when removing the workspace should also offer to remove a worktree from disk.
    public var ownsItsDirectory: Bool {
        if case .managedWorktree = origin { return true }
        return false
    }
}

extension Workspace {
    public enum Accent: String, Hashable, Sendable, Codable, CaseIterable {
        case none, red, orange, yellow, green, teal, blue, purple, pink, graphite
    }
}
