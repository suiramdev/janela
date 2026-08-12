import Foundation

/// The one concept a user has to understand to use Janela.
///
/// A session is *a directory with terminals in it*. That is the whole idea.
/// Everything else — projects, worktrees, agents, pull requests — hangs off that
/// sentence rather than competing with it.
///
/// Deliberately **not** modelled here:
/// - An `isWorktree` flag. Worktree-ness is provenance, recorded in `backing`.
/// - Per-session settings trees. Settings are global or per-project; sessions
///   carry state.
/// - Derived status. "Is this session running?" is a question about its terminals,
///   answered on demand, never stored.
public struct Session: Identifiable, Hashable, Sendable, Codable {
    public let id: SessionID

    /// The project this session belongs to, or `nil` for a standalone session.
    ///
    /// Optional, and that is load-bearing: "just give me a terminal in this folder"
    /// is a first-class case, not a degenerate one. A standalone session has no
    /// automation, no worktree option and no forge state because it has no project
    /// to get them from — nothing else differs.
    public var projectID: ProjectID?

    /// User-facing name. Never required to be unique; identity is the `SessionID`.
    public var name: String

    /// The directory terminals open in. This is the session's centre of gravity.
    ///
    /// Stored as an absolute path. It may be a plain folder, a project's own
    /// checkout, or a git worktree; `backing` records how it came to exist.
    public var directory: URL

    /// How this session's directory came about.
    public var backing: Backing

    /// The terminals this session owns, in creation order. Their *arrangement* is
    /// `layout`; this is the flat set of things that exist.
    public var terminals: [TerminalDescriptor]

    /// Tabs and splits over `terminals`.
    public var layout: SessionLayout

    /// Freeform colour tag used in the sidebar. Purely cosmetic, and that is fine.
    public var accent: Accent

    public var createdAt: Date
    public var lastActiveAt: Date

    /// Set when the user pins a session to the top of its group.
    public var isPinned: Bool

    public init(
        id: SessionID = SessionID(),
        projectID: ProjectID? = nil,
        name: String,
        directory: URL,
        backing: Backing,
        terminals: [TerminalDescriptor] = [],
        layout: SessionLayout = SessionLayout(),
        accent: Accent = .none,
        createdAt: Date = .now,
        lastActiveAt: Date = .now,
        isPinned: Bool = false
    ) {
        self.id = id
        self.projectID = projectID
        self.name = name
        self.directory = directory
        self.backing = backing
        self.terminals = terminals
        self.layout = layout
        self.accent = accent
        self.createdAt = createdAt
        self.lastActiveAt = lastActiveAt
        self.isPinned = isPinned
    }
}

extension Session {

    /// Where a session's directory came from.
    ///
    /// This is the *only* place worktree-ness enters the model. A worktree-backed
    /// session is a normal session with extra provenance — not a separate type,
    /// not a separate list, not a separate screen. That asymmetry is the whole
    /// product thesis; see docs/product.md.
    public enum Backing: Hashable, Sendable, Codable {

        /// A directory the user picked, with no project. No git involvement assumed
        /// (though the directory may well be a repo — we detect that
        /// opportunistically and never act on it uninvited).
        case folder

        /// The project's own directory. A "simple" session: no worktree, no
        /// isolation, and we must never offer to delete the directory — it is the
        /// user's checkout.
        case projectDirectory

        /// A git worktree. `ownership` decides whether we may remove it.
        case worktree(WorktreeBinding)
    }

    /// The worktree binding, if this session has one.
    public var worktree: WorktreeBinding? {
        switch backing {
        case .worktree(let binding): binding
        case .folder, .projectDirectory: nil
        }
    }

    /// True when this session is standalone — no project, no automation, no forge.
    public var isStandalone: Bool { projectID == nil }

    /// True when removing the session should also offer to remove a directory from
    /// disk.
    ///
    /// Only ever true for a worktree Janela created. An adopted worktree existed
    /// before us and we do not get to destroy it on a hunch; a project directory is
    /// the user's checkout and destroying it would be catastrophic.
    public var ownsItsDirectory: Bool {
        guard case .worktree(let binding) = backing else { return false }
        return binding.ownership == .managed
    }
}

/// Ties a session's directory to the branch it was cut from.
///
/// Kept as a small value type rather than a first-class entity on purpose: a
/// worktree has no independent life cycle in Janela. It is created with a session
/// and dies with it. Giving it an identity would be the first step back toward a
/// worktree-centric model.
public struct WorktreeBinding: Hashable, Sendable, Codable {

    /// Branch checked out in the worktree. `nil` for a detached HEAD.
    public var branch: String?

    /// The commit the worktree was created at. Useful for detached-HEAD display and
    /// for telling the user how far behind they are.
    public var baseCommit: String?

    /// Absolute path of the worktree directory as git reports it. Should match the
    /// owning session's `directory`; a mismatch means the user moved it behind our
    /// back and we should re-resolve rather than guess.
    public var path: URL

    /// Whether Janela created this worktree, and may therefore offer to delete it.
    public var ownership: Ownership

    /// What `.worktreeinclude` copied in, recorded at creation time rather than
    /// recomputed at deletion time.
    ///
    /// This is what lets the removal dialog say "and a 400 MB `node_modules`, and
    /// an `.env` that exists nowhere else" instead of "are you sure?". See
    /// docs/decisions/0013-worktreeinclude.md.
    public var includedPaths: [String]

    public init(
        branch: String?,
        baseCommit: String? = nil,
        path: URL,
        ownership: Ownership,
        includedPaths: [String] = []
    ) {
        self.branch = branch
        self.baseCommit = baseCommit
        self.path = path
        self.ownership = ownership
        self.includedPaths = includedPaths
    }

    /// Who created the worktree, which is the same question as who may delete it.
    public enum Ownership: String, Hashable, Sendable, Codable {

        /// Janela created it, so Janela may offer to remove it.
        case managed

        /// It already existed when we found it. We will never delete one of these
        /// without an explicit, unambiguous user action.
        case adopted
    }
}
