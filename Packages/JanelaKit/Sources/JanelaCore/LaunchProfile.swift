import Foundation

/// A named thing you can start in a terminal.
///
/// This is Janela's entire "agent integration" surface, and that is intentional.
/// We do not wrap Claude Code, parse Codex's output, or model an agent's task
/// graph. We make it one keystroke to start the tool the user already has, in the
/// right directory, with a sensible title. See docs/product.md § Non-goals.
public struct LaunchProfile: Identifiable, Hashable, Sendable, Codable {
    public let id: LaunchProfileID

    /// Shown in the new-session menu, e.g. "Claude Code".
    public var name: String

    /// SF Symbol name for the tab and menu.
    public var symbolName: String

    /// Executable plus arguments. Not a shell string: we never hand user input to
    /// `sh -c`, so there is no quoting bug class here.
    ///
    /// An empty `command` means "the user's login shell", resolved at launch.
    public var command: [String]

    /// Extra environment on top of the inherited one. Values are not secrets;
    /// anything sensitive should come from the user's own shell configuration.
    public var environment: [String: String]

    /// Whether this profile counts as an agent for UI purposes (distinct tab icon,
    /// included in "notify me when agents finish"). Purely presentational.
    public var isAgent: Bool

    /// Profiles Janela ships with cannot be deleted, only overridden by copying.
    public var isBuiltIn: Bool

    public init(
        id: LaunchProfileID = LaunchProfileID(),
        name: String,
        symbolName: String = "terminal",
        command: [String] = [],
        environment: [String: String] = [:],
        isAgent: Bool = false,
        isBuiltIn: Bool = false
    ) {
        self.id = id
        self.name = name
        self.symbolName = symbolName
        self.command = command
        self.environment = environment
        self.isAgent = isAgent
        self.isBuiltIn = isBuiltIn
    }
}

extension LaunchProfile {

    /// The profiles Janela offers out of the box.
    ///
    /// These are *suggestions*, not integrations: if the binary is not on the
    /// user's PATH the profile is hidden rather than shown broken. Adding a new
    /// entry here must never require code changes elsewhere.
    public static let builtIns: [LaunchProfile] = [
        LaunchProfile(name: "Shell", symbolName: "terminal", command: [], isBuiltIn: true),
        LaunchProfile(
            name: "Claude Code",
            symbolName: "sparkles",
            command: ["claude"],
            isAgent: true,
            isBuiltIn: true
        ),
        LaunchProfile(
            name: "Codex",
            symbolName: "chevron.left.forwardslash.chevron.right",
            command: ["codex"],
            isAgent: true,
            isBuiltIn: true
        ),
        LaunchProfile(
            name: "OpenCode",
            symbolName: "cube",
            command: ["opencode"],
            isAgent: true,
            isBuiltIn: true
        ),
    ]
}
