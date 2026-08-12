import Foundation

/// A type-safe, opaque identifier.
///
/// Using a phantom type here means a `SessionID` can never be passed where a
/// `WorkspaceID` is expected, which matters once these start crossing module and
/// database boundaries.
public struct Identifier<Subject>: Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: UUID

    public init(rawValue: UUID = UUID()) {
        self.rawValue = rawValue
    }

    public var description: String { rawValue.uuidString }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(UUID.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public typealias WorkspaceID = Identifier<Workspace>
public typealias RepositoryID = Identifier<Repository>
public typealias SessionID = Identifier<TerminalSessionDescriptor>
public typealias LaunchProfileID = Identifier<LaunchProfile>
