import Foundation

/// An error that is safe and useful to put in front of a person.
///
/// Janela's rule: an error either conforms to this and is shown, or it does not
/// and is logged. We never surface a raw `NSError` description or a git stderr
/// dump in a dialog — those become a bug report, not a recovery path.
public protocol UserFacingError: Error {
    /// One short sentence. No error codes, no jargon, no trailing period-free
    /// fragments. "Couldn't create the worktree."
    var summary: String { get }

    /// Optional second sentence explaining *why*, in the user's terms.
    var reason: String? { get }

    /// What the user can actually do next, if anything.
    var recoverySuggestion: String? { get }
}

extension UserFacingError {
    public var reason: String? { nil }
    public var recoverySuggestion: String? { nil }
}

/// Wraps an arbitrary error for logging without ever showing it verbatim.
public struct UnexpectedFailure: UserFacingError {
    public let summary: String
    public let underlying: any Error

    public init(summary: String, underlying: any Error) {
        self.summary = summary
        self.underlying = underlying
    }

    public var recoverySuggestion: String? {
        "If this keeps happening, please file an issue with the Console log."
    }
}
