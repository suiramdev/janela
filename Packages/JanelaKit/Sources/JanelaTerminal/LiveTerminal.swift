import Foundation
import JanelaCore
import JanelaPTY
import JanelaSupport

/// A live terminal: a PTY, a child process, and the authoritative screen.
///
/// ## Why `LiveTerminal` and not `Terminal`
///
/// SwiftTerm exports a type called `Terminal`, and this module imports SwiftTerm.
/// A same-named type here would be resolved by whichever import wins. The `Live`
/// prefix also carries meaning: this is the running counterpart of
/// `TerminalDescriptor`, which is the persistable one.
///
/// ## Where this runs
///
/// **In the daemon, never in a client.** It owns the child process, so it outlives
/// every window; clients receive repaint sequences and render them. That is why
/// this is an `actor` rather than a `@MainActor` observable class — there is no
/// main actor in `janelad`, and nothing here exists to be displayed directly.
/// See docs/decisions/0015-daemon-owned-sessions.md.
///
/// ## Lazy by default
///
/// Constructing one costs nothing — no PTY, no process, no emulator. `start()` is
/// what allocates, which is what makes 40 configured terminals viable and why
/// `TerminalState.idle` is a first-class state.
public actor LiveTerminal {

    public let id: TerminalID
    public let sessionID: SessionID

    public private(set) var descriptor: TerminalDescriptor
    public private(set) var state: TerminalState = .idle

    /// Live title, following OSC 0/2. Falls back to the descriptor's title.
    public private(set) var displayTitle: String

    /// Working directory as last reported via OSC 7, when shell integration is
    /// present. `nil` means "we don't know", which is a normal state.
    public private(set) var reportedWorkingDirectory: URL?

    /// Viewports of every attached client, keyed by connection.
    ///
    /// The PTY gets the **minimum** of these, because a grid larger than a client's
    /// window is one that client cannot fully see. Empty means nobody is attached,
    /// which does not stop the process — see
    /// docs/decisions/0016-daemon-protocol.md § Terminal size with multiple clients.
    private var viewports: [UUID: GridDimensions] = [:]

    public init(descriptor: TerminalDescriptor, sessionID: SessionID) {
        self.id = descriptor.id
        self.descriptor = descriptor
        self.sessionID = sessionID
        self.displayTitle = descriptor.title
    }

    /// Spawns the process. Idempotent: calling it on a running terminal is a no-op.
    public func start() async {}

    /// Sends SIGHUP to the process group and tears down the PTY.
    public func stop() async {}

    /// Restarts in place, keeping the terminal's identity and its place in the
    /// session's layout.
    public func restart() async {}

    /// User keyboard input, forwarded from a client.
    ///
    /// Goes straight to the PTY with no interpretation. Janela implements no key
    /// bindings the terminal should own, and a client that pre-processes input has
    /// made the same mistake one process further out.
    public func send(_ bytes: [UInt8]) {}

    /// Registers a client's viewport and returns the resulting PTY size.
    public func attach(client: UUID, viewport: GridDimensions) -> GridDimensions {
        viewports[client] = viewport
        return negotiatedSize()
    }

    public func detach(client: UUID) -> GridDimensions? {
        viewports.removeValue(forKey: client)
        return viewports.isEmpty ? nil : negotiatedSize()
    }

    /// The smallest attached viewport, which is the size the PTY is set to.
    private func negotiatedSize() -> GridDimensions {
        viewports.values.reduce(GridDimensions.unbounded) { smallest, viewport in
            GridDimensions(
                columns: min(smallest.columns, viewport.columns),
                rows: min(smallest.rows, viewport.rows)
            )
        }
    }

    // TODO: The authoritative grid. Feed PTY bytes to a headless emulator, track
    // damage, and expose two encoders:
    //
    //   - `repaintSinceRevision(_:)` — minimal escape sequences for what changed,
    //     called once per frame per attached client.
    //   - `fullRepaint()` — the whole grid as escape sequences, sent on attach.
    //     This is what makes reattaching correct rather than lucky.
    //
    // Both are the hard part of docs/decisions/0015-daemon-owned-sessions.md, and a
    // correct-but-dumb full repaint every frame is a valid first implementation.
    // Test with two emulators and assert the grids match — docs/testing.md.
}

/// A terminal's size in cells.
///
/// Cells rather than pixels: pixel metrics belong to a client's display and do not
/// survive two clients on different screens.
public struct GridDimensions: Hashable, Sendable {
    public var columns: Int
    public var rows: Int

    public init(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
    }

    /// The identity for a `min` reduction over attached viewports.
    static let unbounded = GridDimensions(columns: .max, rows: .max)
}

/// Every live terminal in the daemon, keyed by id.
///
/// Single source of truth for "what is running". The session layer asks before it
/// lets a worktree be removed, and the daemon asks before deciding it may exit.
public actor TerminalRegistry {

    private var terminals: [TerminalID: LiveTerminal] = [:]

    public init() {}

    public func terminal(for id: TerminalID) -> LiveTerminal? { terminals[id] }

    public func register(_ terminal: LiveTerminal) {
        terminals[terminal.id] = terminal
    }

    public func remove(_ id: TerminalID) {
        terminals.removeValue(forKey: id)
    }

    /// Terminals belonging to a session, across every tab and split.
    ///
    /// This is what makes a session's status derived rather than stored, and what
    /// "closing a session kills its terminals" means — including panes no client
    /// ever attached to.
    public func terminals(in sessionID: SessionID) -> [LiveTerminal] {
        terminals.values.filter { $0.sessionID == sessionID }
    }

    /// How many terminals hold a live process.
    ///
    /// The daemon's idle-exit rule depends on this: a daemon with live terminals
    /// stays even with no clients connected.
    public var liveTerminalCount: Int {
        get async {
            var count = 0
            for terminal in terminals.values where await terminal.state.isLive {
                count += 1
            }
            return count
        }
    }
}
