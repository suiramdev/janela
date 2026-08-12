import Foundation
import JanelaCore
import JanelaProtocol

/// The client half of the terminal seam: something that draws.
///
/// ## Two seams, one library
///
/// `JanelaTerminal` (daemon) owns `TerminalEmulating` — the authoritative grid and
/// the repaint encoder. This owns `TerminalRendering` — fonts, painting, selection,
/// keyboard. Both are backed by SwiftTerm, and **only these two modules may import
/// it**. The rule did not change when the daemon arrived; there are simply two
/// places it applies. See docs/decisions/0004-terminal-engine.md.
///
/// ## Why a renderer can stay this simple
///
/// It is fed **escape sequences**, exactly as a real terminal is fed them from a
/// pty. The daemon has already done the hard part: it holds the grid, tracks
/// damage, and emits the shortest sequence that repaints what changed. So this type
/// needs no notion of a grid diff, no custom wire format, and no knowledge that a
/// daemon exists — which is also why a web client can be xterm.js with no
/// adaptation.
@MainActor
public protocol TerminalRendering: AnyObject {

    /// Feed bytes from the daemon. Repaint sequences, indistinguishable from what a
    /// child process would have written.
    func feed(_ bytes: [UInt8])

    /// The size this surface can display, in cells.
    ///
    /// Reported to the daemon on attach and on resize. The daemon sizes the PTY to
    /// the *smallest* attached viewport, so this is a vote rather than a command —
    /// see docs/decisions/0016-daemon-protocol.md.
    var viewport: GridSize { get }

    /// Called when the user resizes; the client forwards it as a `resize` message.
    var onViewportChange: ((GridSize) -> Void)? { get set }

    /// Keyboard input, sent straight on with no interpretation.
    ///
    /// Janela implements no key bindings the terminal should own. Splits and tabs
    /// use `⌘` chords precisely so this stays true; a surface that swallowed a
    /// `Ctrl` sequence would break the program running in it.
    var onInput: (([UInt8]) -> Void)? { get set }

    /// Selected text, for Copy. Selection is client-side: two clients attached to
    /// one terminal select independently, because a selection is a thing a person
    /// is doing, not a property of the process.
    func selectedText() -> String?

    /// Clears the local view without touching the daemon's scrollback.
    func clearViewport()
}

// TODO: `TerminalSurface`, an NSViewRepresentable wrapping SwiftTerm's
// TerminalView and conforming to `TerminalRendering`.
//
// Two things it must not do, both of which are tempting:
//   - Own a PTY. `TerminalView` will happily start a process; that is the daemon's
//     job now, and a client that spawns one has broken the architecture.
//   - Interpret input. Forward bytes, do not translate them.
