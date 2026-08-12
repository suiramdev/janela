import Foundation
import JanelaCore
import JanelaProtocol

/// Decides whether a terminal's signal deserves the user's attention.
///
/// ## Why this is in the client
///
/// The daemon detects the signal — it owns the emulator, so it is what sees a BEL.
/// But it has no idea which terminal the user is looking at, whether any window is
/// frontmost, or whether a human is present at all. Those facts live here, in the
/// process that has a window.
///
/// So the daemon emits a *fact* and this decides what it means. Shipping focus
/// state to the daemon so it could decide would be a chatty protocol serving no
/// one. See docs/decisions/0011-notifications.md.
@MainActor
public struct AttentionPolicy {

    /// What the client knows that the daemon does not.
    public struct Context: Sendable {
        public var isApplicationActive: Bool
        public var selectedSessionID: SessionID?
        public var focusedTerminalID: TerminalID?

        public init(
            isApplicationActive: Bool,
            selectedSessionID: SessionID? = nil,
            focusedTerminalID: TerminalID? = nil
        ) {
            self.isApplicationActive = isApplicationActive
            self.selectedSessionID = selectedSessionID
            self.focusedTerminalID = focusedTerminalID
        }
    }

    /// Coalescing window. A build that rings the bell four times is one
    /// notification; the alternative trains users to dismiss without reading.
    public static let coalescingWindow: Duration = .seconds(5)

    /// A command must have run at least this long before its failure is worth
    /// interrupting for. Short commands failing is normal work, not an event.
    public static let longRunningThreshold: Duration = .seconds(10)

    /// Signals already delivered, so two windows do not double-notify.
    private var delivered: Set<UUID> = []

    public init() {}

    /// Whether this signal should reach Notification Centre.
    ///
    /// In-app state — the pane indicator and the sidebar badge — is updated
    /// **regardless** of what this returns. The sidebar is the primary channel and
    /// it needs no permission; this decides only whether to interrupt.
    public mutating func shouldDeliver(_ signal: AttentionSignal, in context: Context) -> Bool {
        guard !delivered.contains(signal.id) else { return false }

        // The user is looking straight at it.
        if context.isApplicationActive
            && context.selectedSessionID == signal.sessionID
            && context.focusedTerminalID == signal.terminalID
        {
            return false
        }

        switch signal.kind {
        case .bell:
            // A bare BEL badges but does not interrupt unless asked for. Programs
            // ring it for reasons the user has not agreed are important.
            return false

        case .notification:
            // The program asked for a notification by name. That is consent.
            delivered.insert(signal.id)
            return true

        case .promptFinished(let exitCode, let duration):
            guard let exitCode, exitCode != 0 else { return false }
            guard duration >= Double(Self.longRunningThreshold.components.seconds) else {
                return false
            }
            delivered.insert(signal.id)
            return true
        }
    }

    // TODO: expire `delivered` entries past the coalescing window, and clear a
    // session's entries when it is removed. A notification for a session that no
    // longer exists is a bug the user sees.
}

/// How a delivered signal reaches the user.
///
/// Implemented in `JanelaApp` over `UNUserNotificationCenter`, because that is an
/// app-level API and `JanelaClient` must stay testable without one. Policy above is
/// unit-tested against a recording fake; this is a thin adapter with nothing worth
/// testing.
public protocol AttentionDelivering: Sendable {
    func deliver(_ signal: AttentionSignal, sessionName: String, terminalTitle: String) async
    func withdraw(for sessionID: SessionID) async
}
