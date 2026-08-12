import Foundation
import JanelaCore
import JanelaSupport

/// Resolves the environment a terminal child should be started with.
///
/// ## The problem this solves
///
/// An app launched from Finder inherits `launchd`'s environment, not the user's
/// shell environment. `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. Every tool the
/// user installed with Homebrew, mise, nvm, or asdf is missing. This is the single
/// most common way a GUI terminal app feels broken, and the reason "claude: command
/// not found" gets reported as a bug in the IDE.
///
/// ## The fix
///
/// Start a login shell as the session's process, with `argv[0]` prefixed by `-`,
/// and let the user's own dotfiles build the environment. We never reimplement
/// their shell configuration and we never parse their `.zshrc`.
///
/// For the cases where we need the environment *ourselves* — checking whether
/// `claude` exists before offering the profile — we run the login shell once at
/// startup and cache the result.
public struct ShellEnvironment: Sendable {

    /// The user's login shell, from `getpwuid`, falling back to `$SHELL` and then
    /// `/bin/zsh`. Never hardcoded.
    public let loginShell: URL

    /// Environment captured from a single login-shell invocation at startup.
    public let resolved: [String: String]

    public init(loginShell: URL, resolved: [String: String]) {
        self.loginShell = loginShell
        self.resolved = resolved
    }

    /// Variables Janela sets on every session it starts.
    ///
    /// Keep this list short: every variable here is one the user cannot control,
    /// and terminal programs are unusually sensitive to this namespace.
    public static func janelaVariables(sessionID: SessionID, workspaceName: String) -> [String: String] {
        [
            // Declaring xterm-256color rather than a bespoke terminfo entry means
            // every existing tool works on day one. Revisit only if we ship a
            // terminfo file, and see docs/decisions/0004-terminal-engine.md first.
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "TERM_PROGRAM": "Janela",
            // Lets scripts and agents detect they are inside Janela.
            "JANELA_SESSION_ID": sessionID.description,
            "JANELA_WORKSPACE": workspaceName,
        ]
    }

    /// Builds the argument vector for a login shell.
    ///
    /// The leading `-` is not cosmetic: `zsh` checks `argv[0][0] == '-'` to decide
    /// whether to source `.zprofile`.
    public func loginShellArguments() -> [String] {
        ["-" + loginShell.lastPathComponent]
    }
}
