import Foundation
import JanelaCore
import JanelaGit
import JanelaPersistence
import JanelaSupport

/// Projects, and the operations that change them.
///
/// Runs in the daemon alongside `SessionService`, and separate from it because the
/// two answer different questions: this one owns "what has the user added and how
/// is it configured", the other owns "what is the user working on".
public actor ProjectService {

    public private(set) var projects: [Project] = []

    private let database: JanelaDatabase
    private let git: any GitRunning
    private let observer: any StateObserving

    public init(database: JanelaDatabase, git: any GitRunning, observer: any StateObserving) {
        self.database = database
        self.git = git
        self.observer = observer
    }

    // MARK: - Reading

    /// Loads persisted projects during daemon startup.
    ///
    /// Database work only: no git, no `PATH` probing, no forge detection. Those
    /// refresh in the background once the daemon is serving, because the first
    /// client to connect is waiting on this.
    public func load() async throws {}

    public func project(for id: ProjectID) -> Project? {
        projects.first { $0.id == id }
    }

    // MARK: - Writing

    /// Registers a directory as a project.
    ///
    /// The **client** chose this directory through an open panel, and hands us the
    /// path. The daemon never discovers directories on its own and never scans the
    /// home directory — that rule is what keeps TCC prompts attributed to the app
    /// the user clicked rather than to a background binary they have never heard
    /// of. See docs/decisions/0017-daemon-lifecycle.md § TCC attribution.
    ///
    /// Detecting whether the directory is a git repository is opportunistic and
    /// never blocks: a plain folder is a perfectly good project that simply cannot
    /// offer worktree-backed sessions.
    public func addProject(directory: URL, name: String?) async throws -> Project {
        // TODO: create the record, announce it, then refresh `git` in the
        // background — remote URL, default branch, and forge detection from the
        // remote host.
        throw UnexpectedFailure(
            summary: "Not implemented yet.",
            underlying: CocoaError(.featureUnsupported)
        )
    }

    /// Removes a project **and everything in it**.
    ///
    /// Deleting a project deletes its sessions, so the caller must have asked the
    /// removal question for each one that owns a directory. This method does not
    /// ask; that is the client's job, and it has already been done by the time we
    /// are called.
    public func removeProject(_ id: ProjectID) async throws {}

    /// Replaces a project's settings — automation commands, worktree placement,
    /// forge preference.
    public func updateSettings(_ settings: ProjectSettings, for id: ProjectID) async throws {}
}
