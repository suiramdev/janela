import Foundation

/// A colour tag shown in the sidebar.
///
/// Shared by `Project` and `Session` because the sidebar shows both, and two
/// parallel colour enums would drift the first time someone added a colour.
///
/// Purely cosmetic, and that is the point: people navigate a list of thirty
/// entries by colour far faster than by name, and a colour costs nothing to learn.
public enum Accent: String, Hashable, Sendable, Codable, CaseIterable {
    case none, red, orange, yellow, green, teal, blue, purple, pink, graphite
}
