import Foundation

/// A directory the user added, so Janela can offer to do things in it.
///
/// A project is a container *and* an index. It contains sessions — deleting a
/// project deletes them — and it indexes a repository so that "new branch" is one
/// step instead of a file picker.
///
/// Deliberately **not** modelled here:
/// - Nested projects, folders, tags. The sidebar is two levels deep, always.
/// - A separate `Repository` type. A project either has a `git` descriptor or it
///   does not; a plain folder is a perfectly good project that simply cannot offer
///   worktree-backed sessions.
///
/// See docs/decisions/0009-projects-sessions-terminals.md.
public struct Project: Identifiable, Hashable, Sendable, Codable {
    public let id: ProjectID

    /// User-facing name. Defaults to the directory name, always editable, never
    /// required to be unique — humans are bad at unique names and we do not need it.
    public var name: String

    /// The project's own directory: a repository's main checkout, or just a folder.
    ///
    /// Note this is git's *main worktree*, not the common dir. Sessions backed by
    /// `.projectDirectory` run here; worktree-backed sessions are cut from here.
    public var directory: URL

    /// Git facts about `directory`, or `nil` when it is not a repository.
    public var git: GitDescriptor?

    /// The only per-scope settings that exist. Everything else is global.
    public var settings: ProjectSettings

    /// Freeform colour tag used in the sidebar. Purely cosmetic, and that is fine —
    /// people navigate a list of 30 sessions by colour far faster than by name.
    public var accent: Accent

    /// Whether the project's session list is expanded in the sidebar.
    ///
    /// Collapsing must do no work: this is a boolean on a struct, and expanding a
    /// project may never trigger git, disk, or forge reads. See
    /// docs/performance.md § Interaction.
    public var isExpanded: Bool

    public var addedAt: Date

    public init(
        id: ProjectID = ProjectID(),
        name: String,
        directory: URL,
        git: GitDescriptor? = nil,
        settings: ProjectSettings = ProjectSettings(),
        accent: Accent = .none,
        isExpanded: Bool = true,
        addedAt: Date = .now
    ) {
        self.id = id
        self.name = name
        self.directory = directory
        self.git = git
        self.settings = settings
        self.accent = accent
        self.isExpanded = isExpanded
        self.addedAt = addedAt
    }
}

extension Project {

    /// True when this project can offer worktree-backed sessions.
    public var supportsWorktrees: Bool { git != nil }
}

// MARK: - Git

/// Cached git facts about a project's directory.
///
/// Every field here is **for display and for preselecting a sheet**. Git is always
/// the source of truth: we re-read rather than reconcile, because a cache that
/// disagrees with git is worse than no cache at all.
public struct GitDescriptor: Hashable, Sendable, Codable {

    /// The `origin` remote URL, when there is one.
    public var remoteURL: String?

    /// Cached at registration time so the "new branch" sheet can preselect
    /// sensibly without shelling out. Refreshed opportunistically, never trusted
    /// for correctness.
    public var defaultBranch: String?

    /// Which forge `remoteURL` points at, if we recognise it.
    ///
    /// Detection is a string match on the host, not a network call. Whether the
    /// integration actually *works* additionally depends on the user having `gh`
    /// or `glab` installed and logged in — see
    /// docs/decisions/0012-forge-integration.md.
    public var forge: Forge?

    public init(remoteURL: String? = nil, defaultBranch: String? = nil, forge: Forge? = nil) {
        self.remoteURL = remoteURL
        self.defaultBranch = defaultBranch
        self.forge = forge
    }
}

/// A code-hosting service Janela can read state from, through the user's own CLI.
///
/// We never hold a credential for either of these. See
/// docs/decisions/0012-forge-integration.md.
public enum Forge: String, Hashable, Sendable, Codable, CaseIterable {
    case gitHub
    case gitLab

    /// The binary we shell out to. Absence on `PATH` means the feature is absent,
    /// not broken.
    public var executableName: String {
        switch self {
        case .gitHub: "gh"
        case .gitLab: "glab"
        }
    }
}

// MARK: - Settings

/// Per-project settings.
///
/// These earn their place because a project is where the differences actually
/// live: one repository needs `pnpm install`, another needs a Python venv, a third
/// needs neither. Per-*session* settings do not earn their place, and adding them
/// needs an ADR.
public struct ProjectSettings: Hashable, Sendable, Codable {

    /// Where worktrees Janela creates are placed.
    public var worktreeRoot: WorktreeRoot

    /// Commands run on project lifecycle events, in order, each in its own visible
    /// terminal. See docs/decisions/0014-project-automation.md.
    public var automation: [AutomationCommand]

    /// Launch profile used for a new session's first terminal. `nil` means the
    /// global default.
    public var defaultProfileID: LaunchProfileID?

    /// Whether to read pull-request and check state for this project's sessions.
    public var isForgeEnabled: Bool

    public init(
        worktreeRoot: WorktreeRoot = .siblingDirectory,
        automation: [AutomationCommand] = [],
        defaultProfileID: LaunchProfileID? = nil,
        isForgeEnabled: Bool = true
    ) {
        self.worktreeRoot = worktreeRoot
        self.automation = automation
        self.defaultProfileID = defaultProfileID
        self.isForgeEnabled = isForgeEnabled
    }
}

/// Where a project's managed worktrees are created.
public enum WorktreeRoot: Hashable, Sendable, Codable {

    /// A `.worktrees/<slug>` directory beside the repository. Keeps `~/` tidy and
    /// keeps relative paths short, which matters because build tools embed them.
    case siblingDirectory

    /// A directory the user chose.
    case custom(URL)
}

// MARK: - Automation

/// A command Janela runs on the user's behalf when something happens to a session.
///
/// Two properties of this type are load-bearing and neither is obvious:
///
/// 1. It lives in **Janela's database**, never in the repository. A committed file
///    that runs commands makes cloning a repo a code-execution vector.
/// 2. `command` is an **argv array**, not a shell string — same rule as
///    `LaunchProfile`, same reason. A user who wants a shell writes
///    `["zsh", "-lc", "…"]` and has chosen that explicitly.
///
/// See docs/decisions/0014-project-automation.md.
public struct AutomationCommand: Identifiable, Hashable, Sendable, Codable {
    public let id: AutomationID

    public var event: AutomationEvent

    /// Executable plus arguments. Never handed to `sh -c`.
    public var command: [String]

    /// Off by default when created from a template, so nothing runs because the
    /// user clicked "add" to read the placeholder.
    public var isEnabled: Bool

    /// How long deletion waits for a `.sessionTeardown` command, in seconds.
    /// Ignored for the other events, which never block anything.
    ///
    /// Stored as an `Int` rather than a `Duration` because it is persisted, and a
    /// retroactive `Codable` conformance on a standard-library type would collide
    /// the day the standard library adds its own. `timeout` is the type-safe view.
    public var timeoutSeconds: Int

    public init(
        id: AutomationID = AutomationID(),
        event: AutomationEvent,
        command: [String],
        isEnabled: Bool = true,
        timeoutSeconds: Int = 30
    ) {
        self.id = id
        self.event = event
        self.command = command
        self.isEnabled = isEnabled
        self.timeoutSeconds = timeoutSeconds
    }

    public var timeout: Duration { .seconds(timeoutSeconds) }
}

/// The lifecycle events a project can attach commands to.
///
/// Three, and adding a fourth needs an ADR. This is not a task runner: there is no
/// scheduling, no retry, no dependency graph, and no conditional execution.
public enum AutomationEvent: String, Hashable, Sendable, Codable, CaseIterable {

    /// A managed worktree exists and `.worktreeinclude` has finished copying.
    /// Ordering matters here: scripts depend on their `.env` already being present.
    case worktreeCreated

    /// A session in this project is opened for the first time. Once per session,
    /// not once per app launch — restarting Janela does not re-run `pnpm dev`.
    case sessionStart

    /// The user asked to delete the session. The only blocking event, bounded by
    /// `AutomationCommand.timeout`.
    case sessionTeardown
}
