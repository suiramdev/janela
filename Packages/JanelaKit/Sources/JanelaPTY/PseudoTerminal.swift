import Darwin
import Foundation
import JanelaSupport

/// Terminal dimensions, in cells and pixels.
///
/// Pixels matter: without them, programs that draw images (kitty graphics, sixel)
/// and some TUI layout code get it wrong. `TIOCSWINSZ` carries both, so we always
/// send both.
public struct TerminalSize: Hashable, Sendable {
    public var columns: UInt16
    public var rows: UInt16
    public var pixelWidth: UInt16
    public var pixelHeight: UInt16

    public init(columns: UInt16, rows: UInt16, pixelWidth: UInt16 = 0, pixelHeight: UInt16 = 0) {
        self.columns = columns
        self.rows = rows
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    public static let `default` = TerminalSize(columns: 80, rows: 24)
}

/// A pseudo-terminal master file descriptor and the child attached to its slave.
///
/// This type is intentionally low-level and non-generic. It knows about file
/// descriptors, `posix_spawn`, and `ioctl`, and nothing about workspaces, agents,
/// or SwiftUI. It is the layer we profile in isolation and the layer we must keep
/// allocation-free on the read path.
///
/// ## Threading
///
/// `PseudoTerminal` is an actor, but the read loop deliberately does **not** hop
/// to the actor per chunk. See `ByteStream` for the handoff strategy and
/// docs/decisions/0003-concurrency-model.md for the reasoning.
public actor PseudoTerminal {

    /// Everything needed to start a child on a new PTY.
    public struct Configuration: Sendable {
        /// Absolute path to the executable. Resolved by the caller; this layer does
        /// not search `PATH`, because doing so correctly requires the user's
        /// environment, which is a higher-level concern.
        public var executableURL: URL

        /// Full argument vector *including* `argv[0]`.
        ///
        /// Login shells need `argv[0]` to begin with `-` (e.g. `-zsh`) or they will
        /// not source the user's profile, which is the single most common cause of
        /// "my PATH is wrong in this terminal app".
        public var arguments: [String]

        public var workingDirectory: URL

        /// The complete environment for the child. Not merged with the parent's —
        /// the caller decides exactly what the child sees.
        public var environment: [String: String]

        public var initialSize: TerminalSize

        public init(
            executableURL: URL,
            arguments: [String],
            workingDirectory: URL,
            environment: [String: String],
            initialSize: TerminalSize = .default
        ) {
            self.executableURL = executableURL
            self.arguments = arguments
            self.workingDirectory = workingDirectory
            self.environment = environment
            self.initialSize = initialSize
        }
    }

    public enum Failure: UserFacingError {
        case couldNotAllocateTerminal(errno: Int32)
        case couldNotStart(path: String, errno: Int32)
        case notRunning

        public var summary: String {
            switch self {
            case .couldNotAllocateTerminal: "Couldn't open a terminal."
            case .couldNotStart(let path, _): "Couldn't start \(path)."
            case .notRunning: "This session isn't running."
            }
        }
    }

    // MARK: Lifecycle

    /// Spawns the child and returns once the PTY is ready to read.
    ///
    /// ## The spawn shape is not negotiable
    ///
    /// **Neither `Foundation.Process` nor `posix_spawn` can give the child a
    /// controlling terminal.** Darwin's `posix_spawn` has no `TIOCSCTTY` file
    /// action, and `POSIX_SPAWN_SETSID` yields a new session *without* a
    /// controlling terminal. `TIOCSCTTY` must be issued by the child, after
    /// `setsid()`, which means it must happen between fork and exec.
    ///
    /// Without a controlling terminal, job control breaks: Ctrl-C delivers no
    /// `SIGINT`, `tcsetpgrp` fails, and any TUI that opens `/dev/tty` misbehaves.
    /// Every coding agent we care about is such a TUI.
    ///
    /// So the only correct implementation is:
    ///
    ///     openpty() → fork() → [child] login_tty(replica); chdir; execve()
    ///
    /// (`forkpty()` is the same thing with less control; we want the child window
    /// to `chdir` and reset signal dispositions before exec.)
    ///
    /// - Warning: Between `fork` and `execve` the child may call **only**
    ///   async-signal-safe functions. Do not allocate, touch Swift runtime
    ///   metadata, call into Foundation, or log in that window — in a Cocoa
    ///   process that is a deadlock waiting to happen. Pre-marshal the `char **`
    ///   argument and environment arrays *before* forking.
    ///
    /// - Important: In the parent, close the replica fd, mark the controller
    ///   `O_NONBLOCK`, and apply `initialSize` with `TIOCSWINSZ` before the child
    ///   can emit anything.
    public init(configuration: Configuration) throws(Failure) {
        _ = configuration
        throw .couldNotAllocateTerminal(errno: ENOSYS)
    }

    /// Writes user input to the child. Must handle partial writes and `EAGAIN`.
    public func write(_ bytes: [UInt8]) throws(Failure) {
        _ = bytes
        throw .notRunning
    }

    /// Applies a new window size and signals `SIGWINCH`.
    ///
    /// Resizes are extremely frequent during a live window drag. This must
    /// coalesce: see docs/performance.md § Resize.
    public func resize(to size: TerminalSize) throws(Failure) {
        _ = size
        throw .notRunning
    }

    /// Sends a signal to the child's *process group*, which is what Ctrl-C does.
    /// Signalling only the direct child leaves grandchildren orphaned and running.
    public func signal(_ signal: Int32) throws(Failure) {
        _ = signal
        throw .notRunning
    }

    /// Closes the master fd and reaps the child. Idempotent.
    public func terminate() async {}
}
