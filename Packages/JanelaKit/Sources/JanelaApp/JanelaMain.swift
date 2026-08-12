import JanelaClient
import JanelaCore
import JanelaProtocol
import JanelaSupport
import JanelaUI
import OSLog
import SwiftUI

/// The composition root.
///
/// Everything is constructed here, once, and injected downward. There is no
/// service locator, no singleton graph, and no `.shared`. If a type needs a
/// dependency, it takes it in `init` — which is also what makes the whole graph
/// substitutable in tests.
///
/// ## What this process is
///
/// A **client**. It renders, it delivers notifications, and it asks `janelad` to do
/// things. It does not own a PTY, a database, or a git checkout — none of those
/// modules are even linked, so it could not if it tried. See
/// docs/decisions/0015-daemon-owned-sessions.md.
///
/// ## Launch budget
///
/// Process start to an interactive window is budgeted at 250 ms cold, and **the
/// window paints before the daemon answers**. Connecting is started here and
/// awaited nowhere: a launch that blocks on a socket has handed the daemon a veto
/// over the launch budget, which is the coupling the two-process split exists to
/// remove. See docs/performance.md § Launch.
public struct JanelaMain: App {

    @State private var environment: AppEnvironment

    public init() {
        _environment = State(initialValue: AppEnvironment.live())
    }

    public var body: some Scene {
        WindowGroup(id: "session") {
            MainWindow()
                .environment(environment.projects)
                .environment(environment.sessions)
                .environment(environment.connection)
                .task {
                    // Deliberately in `.task` rather than `init`: the window is on
                    // screen by the time this runs.
                    await environment.start()
                }
        }
        // Unified toolbar with no title text: the session name lives in the
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

/// The client object graph.
///
/// Held as a single `@State` value so SwiftUI keeps it alive for the process
/// lifetime without any global mutable state.
@MainActor
@Observable
public final class AppEnvironment {

    public let projects: ProjectStore
    public let sessions: SessionStore
    public let connection: DaemonConnection

    public init(projects: ProjectStore, sessions: SessionStore, connection: DaemonConnection) {
        self.projects = projects
        self.sessions = sessions
        self.connection = connection
    }

    /// Builds the production graph.
    ///
    /// Note how little happens here compared with the single-process design it
    /// replaced: no database to open, no fallback to an in-memory store, no
    /// migration that could fail on the launch path. Those moved into the daemon,
    /// where a failure surfaces as a connection that does not come up rather than
    /// an app that will not launch.
    public static func live() -> AppEnvironment {
        // TODO: build a Unix socket transport pointed at the daemon's socket, and
        // register the LaunchAgent via SMAppService if it is not already
        // (docs/decisions/0017-daemon-lifecycle.md).
        //
        // `SMAppService.register()` can return `.requiresApproval`, and that is a
        // supported state, not an error: the app runs in a degraded in-app mode and
        // says so plainly. Refusing to work at all would be worse.
        AppEnvironment(
            projects: ProjectStore(),
            sessions: SessionStore(),
            connection: DaemonConnection(transport: PlaceholderTransport())
        )
    }

    /// Connects to the daemon. Called after first paint, never before it.
    public func start() async {
        await connection.connect()
    }
}

/// Stands in until the socket transport exists.
///
/// Its only job is to let the app launch and render its disconnected state, which
/// is a state the UI must handle correctly anyway — the daemon can be restarting at
/// any moment.
private struct PlaceholderTransport: MessageTransport {

    var incoming: AsyncThrowingStream<Frame, any Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func send(_ frame: Frame) async throws {
        Log.app.debug("Dropping frame: no transport yet")
    }

    func close() async {}
}
