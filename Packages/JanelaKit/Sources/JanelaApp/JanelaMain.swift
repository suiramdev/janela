import JanelaGit
import JanelaPersistence
import JanelaSupport
import JanelaTerminal
import JanelaUI
import JanelaWorkspace
import OSLog
import SwiftUI

/// The composition root.
///
/// Everything is constructed here, once, and injected downward. There is no
/// service locator, no singleton graph, and no `.shared`. If a type needs a
/// dependency, it takes it in `init` — which is also what makes the whole graph
/// substitutable in tests.
///
/// ## Launch budget
///
/// Time from process start to an interactive window is budgeted at 250 ms cold.
/// Nothing on this path may do file I/O beyond opening the database, and nothing
/// may block on git or on resolving the user's shell environment — both are
/// kicked off as background work after first paint. See docs/performance.md.
public struct JanelaMain: App {

    @State private var environment: AppEnvironment

    public init() {
        _environment = State(initialValue: AppEnvironment.live())
    }

    public var body: some Scene {
        WindowGroup(id: "workspace") {
            WorkspaceWindow()
                .environment(environment.workspaces)
                .environment(environment.sessions)
        }
        // Unified toolbar with no title text: the workspace name lives in the
        // sidebar, and repeating it in the title bar wastes the only horizontal
        // space the terminal actually wants.
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { JanelaCommands() }

        Settings {
            SettingsWindow()
        }
    }
}

/// The object graph.
///
/// Held as a single `@State` value so SwiftUI keeps it alive for the process
/// lifetime without any global mutable state.
@MainActor
@Observable
public final class AppEnvironment {

    public let workspaces: WorkspaceStore
    public let sessions: SessionRegistry

    public init(workspaces: WorkspaceStore, sessions: SessionRegistry) {
        self.workspaces = workspaces
        self.sessions = sessions
    }

    /// Builds the production graph. The only place that touches the real database.
    ///
    /// Failing to open the database is not fatal. A developer tool that refuses to
    /// launch because a SQLite file is corrupt is worse than one that launches
    /// without history, so we fall back to an in-memory store and surface
    /// `persistenceFailure` so the UI can say so.
    public static func live() -> AppEnvironment {
        let sessions = SessionRegistry()
        let git = GitRunner()
        let worktrees = WorktreeService(git: git)

        var persistenceFailure: (any Error)?
        let database: JanelaDatabase
        do {
            database = try JanelaDatabase.open(at: try JanelaDatabase.defaultURL())
        } catch {
            Log.persistence.error(
                "Falling back to in-memory store: \(error.localizedDescription, privacy: .public)")
            persistenceFailure = error
            do {
                database = try JanelaDatabase.inMemory()
            } catch {
                // SQLite itself is unusable. There is no meaningful degraded mode
                // left, and pretending otherwise would only fail later and worse.
                preconditionFailure("SQLite is unavailable: \(error)")
            }
        }

        let workspaces = WorkspaceStore(
            database: database,
            worktrees: worktrees,
            sessions: sessions
        )

        let environment = AppEnvironment(workspaces: workspaces, sessions: sessions)
        environment.persistenceFailure = persistenceFailure
        return environment
    }

    /// Non-nil when the on-disk store could not be opened and this session is
    /// running against a throwaway in-memory database.
    public internal(set) var persistenceFailure: (any Error)?
}
