import Foundation

/// How a session arranges its terminals: tabs, each holding a tree of splits.
///
/// This is per-session *state*, persisted with the session — not a saved object
/// the user names and manages. "The layout is wherever you left it" only works if
/// where you left it is written down. See
/// docs/decisions/0010-terminal-layout.md.
public struct SessionLayout: Hashable, Sendable, Codable {

    /// Ordered, as the user arranged them. Never empty in a session that has
    /// terminals; a session with no terminals has no tabs.
    public private(set) var tabs: [Tab]

    /// Index into `tabs`. Clamped on decode rather than trusted.
    public private(set) var focusedTabIndex: Int

    public init(tabs: [Tab] = [], focusedTabIndex: Int = 0) {
        self.tabs = tabs
        self.focusedTabIndex = tabs.isEmpty ? 0 : min(max(0, focusedTabIndex), tabs.count - 1)
    }

    /// The layout for a brand-new session: one tab, one terminal, no splits.
    public init(singleTerminal id: TerminalID) {
        self.init(tabs: [Tab(root: .terminal(id), focusedTerminalID: id)], focusedTabIndex: 0)
    }

    public var focusedTab: Tab? {
        tabs.indices.contains(focusedTabIndex) ? tabs[focusedTabIndex] : nil
    }

    /// Every terminal referenced anywhere in the layout, in tab then tree order.
    public var terminalIDs: [TerminalID] {
        tabs.flatMap(\.root.terminalIDs)
    }
}

extension SessionLayout {

    /// One tab: a title, a tree of panes, and which pane has focus.
    public struct Tab: Hashable, Sendable, Codable {

        /// `nil` means "derive from the focused terminal", which is what users
        /// expect until they rename a tab explicitly.
        public var title: String?

        public var root: Pane

        /// Must name a terminal present in `root`. Repaired rather than trusted on
        /// load: a focus pointing at nothing falls back to the first terminal.
        public var focusedTerminalID: TerminalID

        public init(title: String? = nil, root: Pane, focusedTerminalID: TerminalID) {
            self.title = title
            self.root = root
            self.focusedTerminalID = focusedTerminalID
        }
    }

    /// A node in a tab's split tree: either a terminal, or a division of two panes.
    ///
    /// Binary rather than n-ary because every split operation the UI offers is
    /// binary, and because promoting a sibling when a pane closes is trivial in a
    /// binary tree and fiddly in an n-ary one.
    public indirect enum Pane: Hashable, Sendable, Codable {
        case terminal(TerminalID)
        case split(axis: Axis, fraction: Double, first: Pane, second: Pane)

        /// Maximum nesting depth of a split tree.
        ///
        /// This is not a style preference. `Pane` is `indirect` and decoded from a
        /// persisted blob, so an unbounded depth is a decoding hazard; and past
        /// about four levels a pane is too small to read anyway. Deeper trees are
        /// a misclick, not a workflow.
        public static let maximumDepth = 6

        /// Fractions are clamped to this range, because a pane you cannot see is a
        /// pane you cannot close.
        public static let fractionRange: ClosedRange<Double> = 0.05...0.95

        /// Every terminal in this subtree, left to right.
        public var terminalIDs: [TerminalID] {
            switch self {
            case .terminal(let id):
                [id]
            case .split(_, _, let first, let second):
                first.terminalIDs + second.terminalIDs
            }
        }

        /// Nesting depth, where a bare terminal is 1.
        public var depth: Int {
            switch self {
            case .terminal:
                1
            case .split(_, _, let first, let second):
                1 + max(first.depth, second.depth)
            }
        }

        // TODO: The layout algebra — split(_:along:), closing(_:) with sibling
        // promotion, and focus traversal. All pure, all cheap to test, and every
        // rule is written down in docs/decisions/0010-terminal-layout.md.
        // See docs/development.md § First tasks.
    }

    /// Which way a split divides its two panes.
    public enum Axis: String, Hashable, Sendable, Codable {
        /// Panes side by side; the divider is vertical.
        case horizontal
        /// Panes stacked; the divider is horizontal.
        case vertical
    }
}
