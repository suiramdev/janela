import SwiftUI

/// Janela's visual constants.
///
/// The bar for adding something here: it is used in at least two places, or it
/// encodes a decision someone would otherwise get wrong. Everything else is a
/// literal at the call site, where it is easier to read.
///
/// Colours are semantic, not literal. There is no `Janela.blue`, because a name
/// like that tells you nothing about when to use it and guarantees drift.
public enum Metrics {
    /// The 4-point grid everything snaps to.
    public static let gridUnit: CGFloat = 4

    public static func grid(_ multiple: CGFloat) -> CGFloat { gridUnit * multiple }

    /// Sidebar bounds. Below the minimum, session names truncate uselessly — and
    /// they sit indented under a project, so they start further right than the
    /// width alone suggests.
    public static let sidebarMinimumWidth: CGFloat = 180
    public static let sidebarIdealWidth: CGFloat = 240
    public static let sidebarMaximumWidth: CGFloat = 400

    /// Corner radii, matched to macOS 26's control shapes.
    public static let cornerRadiusSmall: CGFloat = 6
    public static let cornerRadiusMedium: CGFloat = 10

    /// Terminal padding. Asymmetric on purpose: the extra leading space keeps text
    /// off the window edge without making the first column look indented.
    public static let terminalInsets = EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 6)
}

/// Semantic colours. Every one resolves through the asset catalog so it adapts to
/// light/dark and to Increase Contrast without any code branching.
public enum Palette {
    /// Background behind terminal content.
    public static let terminalBackground = Color("TerminalBackground", bundle: .module)
    /// Badge on a terminal, and on the session button that contains it.
    public static let attention = Color("Attention", bundle: .module)
    /// Indicator for a running terminal.
    public static let running = Color("Running", bundle: .module)
    /// Text and glyphs for a terminal that exited non-zero, including a failed
    /// automation command — whose terminal stays open showing exactly why.
    public static let failure = Color("Failure", bundle: .module)
}

extension Font {
    /// The terminal font. User-overridable in Settings; this is only the default.
    ///
    /// SF Mono is the right default on macOS: it ships with the OS, it has the
    /// glyph coverage Nerd-Font-using agents need less of than you'd think, and it
    /// hints well at small sizes.
    public static func terminal(size: CGFloat) -> Font {
        .system(size: size, weight: .regular, design: .monospaced)
    }
}
