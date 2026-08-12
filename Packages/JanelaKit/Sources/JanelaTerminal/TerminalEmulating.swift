import Foundation
import JanelaCore
import JanelaPTY

/// The seam between Janela and whatever parses VT sequences for us.
///
/// Today this is backed by SwiftTerm. It may not always be — a Metal-rendered
/// emulator or `libghostty` are both plausible futures, and the cost of finding
/// that out later is exactly the size of this protocol. Keep it small.
///
/// Nothing above `JanelaTerminal` may import SwiftTerm. If you find yourself
/// wanting to, the missing capability belongs here instead.
@MainActor
public protocol TerminalEmulating: AnyObject {

    /// Feed bytes from the PTY. Called at most once per frame with a coalesced
    /// chunk — see `TerminalByteStream`.
    func feed(_ bytes: TerminalBytes)

    /// Current grid size, derived from the view's bounds and the cell metrics.
    var size: TerminalSize { get }

    /// Resize the grid. Reflow behaviour is the emulator's business.
    func resize(to size: TerminalSize)

    /// Everything currently on screen and in scrollback, as plain text. Used for
    /// "Copy All" and for the search index. May be expensive; never call per frame.
    func snapshotText() -> String

    /// Clears scrollback without disturbing the visible screen.
    func clearScrollback()

    /// Where the emulator reports notable events. See `TerminalEventSink`.
    var eventSink: (any TerminalEventSink)? { get set }
}

/// Events the emulator surfaces to the rest of the app.
///
/// This list is deliberately short and deliberately *mechanical*. Every entry
/// corresponds to a real escape sequence or a real process event. There is no
/// `agentIsThinking`, because no terminal sequence means that.
@MainActor
public protocol TerminalEventSink: AnyObject {

    /// OSC 0 / OSC 2 — the process set the window or icon title.
    func terminalDidSetTitle(_ title: String)

    /// OSC 7 — the shell reported its working directory. This is how the workspace
    /// header can show where you actually are, and it requires shell integration
    /// the user may not have. Absence is normal; never block a feature on it.
    func terminalDidReportWorkingDirectory(_ url: URL)

    /// BEL, OSC 9, or OSC 777 — the process is asking for attention. This is the
    /// only signal Janela uses to badge a background session, and it is the same
    /// signal a `make && echo -e "\a"` produces. See
    /// docs/decisions/0006-agent-activity-signals.md.
    func terminalDidRequestAttention(_ notification: TerminalNotification)

    /// OSC 133 semantic prompt marks, when the shell emits them. Used to time
    /// long-running commands and to make "notify me when this finishes" accurate.
    func terminalDidMarkPrompt(_ mark: PromptMark)

    /// The child process exited.
    func terminalDidExit(code: Int32)
}

public struct TerminalNotification: Hashable, Sendable {
    public var title: String?
    public var body: String?

    public init(title: String? = nil, body: String? = nil) {
        self.title = title
        self.body = body
    }
}

/// OSC 133 shell-integration markers.
public enum PromptMark: Hashable, Sendable {
    /// `OSC 133 ; A` — a new prompt is about to be drawn.
    case promptStart
    /// `OSC 133 ; C` — the user's command started executing.
    case commandStart
    /// `OSC 133 ; D ; <code>` — the command finished.
    case commandFinished(exitCode: Int32?)
}
