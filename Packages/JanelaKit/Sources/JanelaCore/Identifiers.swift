import Foundation

/// A type-safe, opaque identifier.
///
/// Using a phantom type here means a `TerminalID` can never be passed where a
/// `SessionID` is expected. That matters more than it looks: the model is three
/// levels deep, every level's id is a UUID underneath, and `session(for: id)` with
/// the wrong `id` would otherwise compile and return nil forever.
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

public typealias ProjectID = Identifier<Project>
public typealias SessionID = Identifier<Session>
public typealias TerminalID = Identifier<TerminalDescriptor>
public typealias LaunchProfileID = Identifier<LaunchProfile>
public typealias AutomationID = Identifier<AutomationCommand>
