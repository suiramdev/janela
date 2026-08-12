import Foundation

/// A throwaway git repository with a commit in it.
///
/// Worktree behaviour is not something we can meaningfully fake: `git worktree
/// add` either works against a real repository or it does not. So the git tests
/// use real repositories in temporary directories, and accept the few hundred
/// milliseconds that costs. See docs/testing.md § What we do and don't fake.
public struct GitFixture: Sendable {

    public let directory: TemporaryDirectory
    public var url: URL { directory.url }

    /// Creates a repository with one commit on `main`.
    ///
    /// Sets `user.name`/`user.email` locally and passes `-c commit.gpgsign=false`,
    /// so the suite passes on a machine with signing configured globally.
    public init(function: String = #function) throws {
        directory = try TemporaryDirectory(function: function)
        try Self.run(["init", "--initial-branch=main"], in: url)
        try Self.run(["config", "user.name", "Janela Tests"], in: url)
        try Self.run(["config", "user.email", "tests@janela.invalid"], in: url)
        try Self.run(["config", "commit.gpgsign", "false"], in: url)

        let readme = url.appending(path: "README.md")
        try "# fixture\n".write(to: readme, atomically: true, encoding: .utf8)
        try Self.run(["add", "README.md"], in: url)
        try Self.run(["commit", "-m", "initial"], in: url)
    }

    @discardableResult
    public static func run(_ arguments: [String], in directory: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = ["-C", directory.path(percentEncoded: false)] + arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        // Keep the fixture hermetic: no user config, no prompts, no signing.
        process.environment = [
            "PATH": "/usr/bin:/bin",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
        ]
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let output = String(decoding: data, as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw GitFixtureError(arguments: arguments, output: output)
        }
        return output
    }
}

public struct GitFixtureError: Error, CustomStringConvertible {
    public let arguments: [String]
    public let output: String

    public var description: String {
        "git \(arguments.joined(separator: " ")) failed:\n\(output)"
    }
}
