import Foundation
import JanelaCore
import JanelaProtocol
import JanelaSession
import JanelaSupport
import JanelaTerminal

/// Accepts connections and fans state out to them.
///
/// Deliberately thin. Everything a message *means* lives in `JanelaSession`; this
/// type owns connections, subscriptions and the handshake, and nothing else. If
/// product logic appears here it is in the wrong module, and the test for that is
/// simple: `JanelaSession` must stay usable with no socket at all.
///
/// An actor because its state is a connection table touched from many tasks. Note
/// there is no `@MainActor` anywhere in the daemon — see
/// docs/decisions/0003-concurrency-model.md.
public actor DaemonServer {

    private let sessions: SessionService
    private let projects: ProjectService
    private let terminals: TerminalRegistry

    public init(
        sessions: SessionService,
        projects: ProjectService,
        terminals: TerminalRegistry
    ) {
        self.sessions = sessions
        self.projects = projects
        self.terminals = terminals
    }

    /// Serves until cancelled.
    ///
    /// - Parameter listener: An already-bound listener. In production this wraps the
    ///   descriptor launchd handed us via `launch_activate_socket`, because launchd
    ///   owns the socket and we never bind a path ourselves
    ///   (docs/decisions/0017-daemon-lifecycle.md).
    /// - Throws: Only when the *listener itself* fails — the socket vanishing, or a
    ///   descriptor we cannot accept on. A failure on any single connection is
    ///   handled and logged rather than thrown, because one client sending nonsense
    ///   must never take down a daemon holding another client's terminals.
    public func serve(on listener: any ConnectionListening) async throws {
        // TODO: accept loop. Per connection: check the peer uid, exchange Hello,
        // then run a task that reads frames until the peer goes away. A connection
        // failing — bad handshake, malformed frame, peer crash — must never take
        // down the daemon or another connection.
    }

    /// Broadcasts a state change to every subscriber.
    ///
    /// Called by `SessionService` through a delegate, so the brain never learns that
    /// sockets exist.
    public func publish(_ update: StateUpdate) async {
        // TODO: fan out to subscribers whose scope matches, each with its own
        // bounded queue. A stalled client must not slow the others
        // (docs/performance.md § Terminal throughput).
    }

    /// Whether the daemon may exit.
    ///
    /// False while any terminal is live, however many clients are connected —
    /// including none. That asymmetry is the entire feature: the daemon exists to
    /// outlive clients, not to serve them.
    public func canExitWhenIdle() async -> Bool {
        await terminals.liveTerminalCount == 0
    }
}

/// Something that yields connections.
///
/// A protocol so tests can drive the server over an in-process pair while
/// production uses a real socket — and so a future TLS listener is an
/// implementation rather than a fork in `serve(on:)`.
public protocol ConnectionListening: Sendable {
    func accept() async throws -> any MessageTransport
}
