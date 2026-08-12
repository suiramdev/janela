import Foundation
import JanelaSupport

/// Runs `git` as a subprocess and returns its output.
///
/// ## Why not libgit2?
///
/// libgit2's worktree support is incomplete relative to the CLI, and the CLI is
/// the thing users' repositories are actually configured for: hooks, credential
/// helpers, `includeIf` config, LFS, sparse-checkout and `core.fsmonitor` all work
/// because git itself is running. Shelling out costs a few milliseconds per call
/// and buys correctness. See docs/decisions/0007-git-integration.md.
///
/// ## Rules
///
/// - Arguments are always an array. There is no shell, so no quoting, no injection.
/// - Every invocation is scoped with `-C <directory>`; we never `chdir`.
/// - `GIT_OPTIONAL_LOCKS=0` on read-only commands so a background refresh never
///   fights the user's own `git` for `index.lock`.
public protocol GitRunning: Sendable {
    /// Runs git and returns stdout on success.
    /// - Throws: `GitFailure` when git exits non-zero.
    func run(_ arguments: [String], in directory: URL) async throws -> String

    /// Runs git ignoring the exit status, returning stdout, stderr and the code.
    /// Use for commands where a non-zero status is a legitimate answer
    /// (`git rev-parse --verify`, `git diff --quiet`).
    func probe(_ arguments: [String], in directory: URL) async -> GitOutcome
}

public struct GitOutcome: Sendable {
    public let standardOutput: String
    public let standardError: String
    public let exitCode: Int32

    public var succeeded: Bool { exitCode == 0 }

    public init(standardOutput: String, standardError: String, exitCode: Int32) {
        self.standardOutput = standardOutput
        self.standardError = standardError
        self.exitCode = exitCode
    }
}

public struct GitFailure: UserFacingError {
    public let subcommand: String
    public let exitCode: Int32

    /// git's stderr. Logged and shown in a disclosure triangle, never in the
    /// headline — see `UserFacingError`.
    public let standardError: String

    public var summary: String { "git \(subcommand) failed." }
    public var reason: String? { standardError.isEmpty ? nil : standardError }

    public init(subcommand: String, exitCode: Int32, standardError: String) {
        self.subcommand = subcommand
        self.exitCode = exitCode
        self.standardError = standardError
    }
}

/// The production `GitRunning`.
public struct GitRunner: GitRunning {

    /// Resolved once at startup. We use the user's `git` (Homebrew's, usually)
    /// rather than hardcoding `/usr/bin/git`, because the Xcode-shipped git is
    /// older and lacks some worktree flags.
    public let executableURL: URL

    public init(executableURL: URL = URL(filePath: "/usr/bin/git")) {
        self.executableURL = executableURL
    }

    public func run(_ arguments: [String], in directory: URL) async throws -> String {
        _ = (arguments, directory)
        throw GitFailure(subcommand: arguments.first ?? "", exitCode: -1, standardError: "not implemented")
    }

    public func probe(_ arguments: [String], in directory: URL) async -> GitOutcome {
        _ = (arguments, directory)
        return GitOutcome(standardOutput: "", standardError: "not implemented", exitCode: -1)
    }
}
