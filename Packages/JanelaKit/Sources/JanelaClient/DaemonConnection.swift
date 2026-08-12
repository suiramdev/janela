import Foundation
import JanelaCore
import JanelaProtocol

/// A client's connection to `janelad`, and the mirrored state it produces.
///
/// ## The one rule
///
/// **The daemon is the truth; this is a mirror.** Nothing here computes state it
/// could ask for, and nothing writes state it did not receive. A client that
/// infers — "I sent input, so it must be running" — is guessing about a process in
/// another process. See docs/decisions/0015-daemon-owned-sessions.md § Rules.
///
/// ## Disconnection is normal
///
/// The daemon may be restarting, upgrading, or briefly gone. Views keep rendering
/// the last known mirror with `isStale` set; nothing blocks and nothing is
/// discarded. Terminals are unaffected either way — they are in the daemon, and
/// they kept running.
@MainActor
@Observable
public final class DaemonConnection {

    public enum Status: Hashable, Sendable {
        /// No connection yet, or deliberately disconnected.
        case idle

        case connecting

        /// Connected, handshake complete, receiving state.
        case connected

        /// Connection lost; retrying with backoff. The mirror is still rendered.
        case reconnecting(attempt: Int)

        /// The daemon refused us and retrying will not help. Almost always a
        /// version mismatch after an app update, which needs a human decision —
        /// never an automatic daemon restart, because that kills live terminals.
        case refused(HandshakeRefusal)
    }

    public private(set) var status: Status = .idle

    /// True when the mirror predates the current connection.
    public private(set) var isStale = false

    private let transport: any MessageTransport

    public init(transport: any MessageTransport) {
        self.transport = transport
    }

    /// Connects, handshakes, and subscribes.
    ///
    /// Never called on the launch path in a way that blocks first paint: the window
    /// draws its empty or last-known state and fills in when this resolves. See
    /// docs/performance.md § Launch.
    public func connect() async {
        // TODO: send Hello, await the daemon's, check compatibility, subscribe to
        // `.state`, then pump incoming frames into the stores below. On failure,
        // set `.reconnecting` and retry with backoff — except for `.refused`, which
        // is terminal until the user acts.
    }

    /// Sends a request and waits for its reply.
    ///
    /// Every mutation is a request with a reply, because fire-and-forget mutation is
    /// how a mirror silently diverges from the truth.
    public func request(_ message: ClientMessage) async throws {}

    /// Keyboard input for an attached terminal.
    ///
    /// The one message with no reply: a round trip per keystroke would be absurd,
    /// and the echo is the reply.
    public func sendInput(_ bytes: [UInt8], to terminalID: TerminalID) {}
}
